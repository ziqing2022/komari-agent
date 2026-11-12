package tunnel

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	v2 "github.com/ziqing2022/komari-agent/protocol/v2"
)

var (
	reverseLock       sync.Mutex
	reverseCancels    = make(map[string]context.CancelFunc)
	reverseSignatures = make(map[string]string)
)

func ruleSignature(r v2.TunnelRule) string {
	role := strings.ToLower(strings.TrimSpace(r.Role))
	return fmt.Sprintf("%s|%s|%d|%d|%d|%d|%s|%s|%s|%s|%s|%s|%t",
		r.ID, role, r.ListenPort, r.BridgePort, r.ControlPort, r.TargetPort,
		r.TargetHost, r.TargetType, r.BridgeHost, r.TunnelSecret, r.RuleType, r.Protocol, r.Enabled,
	)
}

// ==========================================
// UDPPacket 帧序列化与反序列化工具 (FRP 机制)
// 帧结构: [RemoteAddrLen (1B uint8)] [RemoteAddr 字符串] [DataLen (2B uint16 BE)] [Data 原始载荷]
// ==========================================

func writeUDPPacket(w io.Writer, remoteAddr string, data []byte) error {
	addrBytes := []byte(remoteAddr)
	if len(addrBytes) > 255 || len(data) > 65535 {
		return fmt.Errorf("udp packet overflow: addrLen=%d, dataLen=%d", len(addrBytes), len(data))
	}
	buf := make([]byte, 1+len(addrBytes)+2+len(data))
	buf[0] = byte(len(addrBytes))
	copy(buf[1:], addrBytes)
	binary.BigEndian.PutUint16(buf[1+len(addrBytes):], uint16(len(data)))
	copy(buf[1+len(addrBytes)+2:], data)
	_, err := w.Write(buf)
	return err
}

func readUDPPacket(r io.Reader) (string, []byte, error) {
	var lenBuf [1]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return "", nil, err
	}
	addrLen := int(lenBuf[0])
	addrBuf := make([]byte, addrLen)
	if _, err := io.ReadFull(r, addrBuf); err != nil {
		return "", nil, err
	}
	var dataLenBuf [2]byte
	if _, err := io.ReadFull(r, dataLenBuf[:]); err != nil {
		return "", nil, err
	}
	dataLen := int(binary.BigEndian.Uint16(dataLenBuf[:]))
	data := make([]byte, dataLen)
	if _, err := io.ReadFull(r, data); err != nil {
		return "", nil, err
	}
	return string(addrBuf), data, nil
}

// SyncReverseTunnels 根据下发的规则同步运行反向穿透 (Bridge 公网端 或 Target 内网端)
// 支持配置变更毫秒级自动热加载与旧任务平滑释放
func SyncReverseTunnels(rules []v2.TunnelRule) {
	reverseLock.Lock()
	defer reverseLock.Unlock()

	activeRuleIDs := make(map[string]bool)

	for _, r := range rules {
		if !r.Enabled || !r.IsReverse {
			continue
		}
		activeRuleIDs[r.ID] = true
		sig := ruleSignature(r)

		// 检查是否已经在运行
		if oldCancel, exists := reverseCancels[r.ID]; exists {
			if reverseSignatures[r.ID] == sig {
				// 配置完全一致，继续稳定运行，无需打扰现有连接
				continue
			}
			// 配置发生变更：优雅取消旧任务并释放旧端口
			log.Printf("[ReverseTunnel] Rule %s config changed, hot-reloading...", r.ID)
			oldCancel()
			delete(reverseCancels, r.ID)
			delete(reverseSignatures, r.ID)
			time.Sleep(100 * time.Millisecond) // 等待旧 listener / socket 释放
		}

		ctx, cancel := context.WithCancel(context.Background())
		reverseCancels[r.ID] = cancel
		reverseSignatures[r.ID] = sig

		role := strings.ToLower(strings.TrimSpace(r.Role))
		if role == "bridge" {
			go runBridgeServer(ctx, r)
		} else {
			go runTargetClient(ctx, r)
		}
	}

	// 停止已经删除或禁用的规则
	for id, cancel := range reverseCancels {
		if !activeRuleIDs[id] {
			cancel()
			delete(reverseCancels, id)
			delete(reverseSignatures, id)
			log.Printf("[ReverseTunnel] Stopped reverse rule: %s", id)
		}
	}
}

// StopAllReverseTunnels 停止全部反向穿透任务
func StopAllReverseTunnels() {
	reverseLock.Lock()
	defer reverseLock.Unlock()
	for id, cancel := range reverseCancels {
		cancel()
		delete(reverseCancels, id)
		delete(reverseSignatures, id)
	}
}

// ==========================================
// 1. 公网端 (Bridge Server) 引擎 (多规则控制端口多路复用)
// ==========================================

type bridgeRuleSession struct {
	rule        v2.TunnelRule
	activeCtrl  net.Conn
	ctrlLock    sync.Mutex
	ctrlWriteMu sync.Mutex
	pendingWork map[string]chan net.Conn
	pendingLock sync.Mutex
	connSeq     uint64

	// FRP 风格 UDP 多路复用隧道专属通道
	udpWorkConn net.Conn
	udpWorkLock sync.Mutex
	udpWriteMu  sync.Mutex
	udpListener *net.UDPConn
}

type bridgeControlHub struct {
	port     int
	listener net.Listener
	mu       sync.RWMutex
	rules    map[string]*bridgeRuleSession // ruleID -> session
	refCount int
	cancel   context.CancelFunc
}

var (
	bridgeHubsMu sync.Mutex
	bridgeHubs   = make(map[int]*bridgeControlHub) // controlPort -> hub
)

// registerBridgeSession 注册规则会话到指定控制端口的共享 Hub (同端口多规则多路复用)
func registerBridgeSession(r v2.TunnelRule, controlPort int) (*bridgeRuleSession, error) {
	bridgeHubsMu.Lock()
	defer bridgeHubsMu.Unlock()

	hub, exists := bridgeHubs[controlPort]
	if !exists {
		listener, err := net.Listen("tcp", fmt.Sprintf(":%d", controlPort))
		if err != nil {
			return nil, fmt.Errorf("failed to listen control port %d: %w", controlPort, err)
		}

		ctx, cancel := context.WithCancel(context.Background())
		hub = &bridgeControlHub{
			port:     controlPort,
			listener: listener,
			rules:    make(map[string]*bridgeRuleSession),
			cancel:   cancel,
		}
		bridgeHubs[controlPort] = hub

		// 启动共享控制端口的 Accept 调度循环
		go hub.runAcceptLoop(ctx)
		log.Printf("[ReverseBridge] Started shared control hub on port %d", controlPort)
	}

	session := &bridgeRuleSession{
		rule:        r,
		pendingWork: make(map[string]chan net.Conn),
	}

	hub.mu.Lock()
	hub.rules[r.ID] = session
	hub.refCount++
	hub.mu.Unlock()

	return session, nil
}

// unregisterBridgeSession 从 Hub 注销规则会话，若该端口无规则运行则自动关闭控制端口监听
func unregisterBridgeSession(ruleID string, controlPort int) {
	bridgeHubsMu.Lock()
	defer bridgeHubsMu.Unlock()

	hub, exists := bridgeHubs[controlPort]
	if !exists {
		return
	}

	hub.mu.Lock()
	session, found := hub.rules[ruleID]
	if found {
		delete(hub.rules, ruleID)
		hub.refCount--

		session.ctrlLock.Lock()
		if session.activeCtrl != nil {
			_ = session.activeCtrl.Close()
			session.activeCtrl = nil
		}
		session.ctrlLock.Unlock()

		session.pendingLock.Lock()
		for _, ch := range session.pendingWork {
			close(ch)
		}
		session.pendingWork = make(map[string]chan net.Conn)
		session.pendingLock.Unlock()

		session.udpWorkLock.Lock()
		if session.udpWorkConn != nil {
			_ = session.udpWorkConn.Close()
			session.udpWorkConn = nil
		}
		session.udpWorkLock.Unlock()

		if session.udpListener != nil {
			_ = session.udpListener.Close()
			session.udpListener = nil
		}
	}
	remaining := hub.refCount
	hub.mu.Unlock()

	if remaining <= 0 {
		if hub.cancel != nil {
			hub.cancel()
		}
		if hub.listener != nil {
			_ = hub.listener.Close()
		}
		delete(bridgeHubs, controlPort)
		log.Printf("[ReverseBridge] Closed shared control hub on port %d", controlPort)
	}
}

func (hub *bridgeControlHub) getSession(ruleID string) *bridgeRuleSession {
	hub.mu.RLock()
	defer hub.mu.RUnlock()
	return hub.rules[ruleID]
}

func (hub *bridgeControlHub) runAcceptLoop(ctx context.Context) {
	defer hub.listener.Close()

	for {
		conn, err := hub.listener.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
				time.Sleep(100 * time.Millisecond)
				continue
			}
		}

		go hub.handleInboundControlConn(conn)
	}
}

func (hub *bridgeControlHub) handleInboundControlConn(c net.Conn) {
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	reader := bufio.NewReader(c)
	line, err := reader.ReadString('\n')
	if err != nil {
		_ = c.Close()
		return
	}
	_ = c.SetDeadline(time.Time{})

	line = strings.TrimSpace(line)
	parts := strings.Split(line, " ")
	if len(parts) < 3 {
		_ = c.Close()
		return
	}

	cmd := parts[0]
	secret := parts[1]
	ruleID := parts[2]

	session := hub.getSession(ruleID)
	if session == nil {
		log.Printf("[ReverseBridge] Rejecting connection for unregistered rule %s from %s", ruleID, c.RemoteAddr())
		_ = c.Close()
		return
	}

	// 密码认证（若规则配置了密钥则严格比对）
	if session.rule.TunnelSecret != "" && secret != session.rule.TunnelSecret {
		log.Printf("[ReverseBridge] Invalid auth secret for rule %s from %s", ruleID, c.RemoteAddr())
		_ = c.Close()
		return
	}

	if cmd == "AUTH" {
		if tc, ok := c.(*net.TCPConn); ok {
			_ = tc.SetKeepAlive(true)
			_ = tc.SetKeepAlivePeriod(15 * time.Second)
		}

		// 控制连接建立
		session.ctrlLock.Lock()
		if session.activeCtrl != nil {
			_ = session.activeCtrl.Close()
		}
		session.activeCtrl = c
		session.ctrlLock.Unlock()

		_, _ = c.Write([]byte("OK\n"))
		log.Printf("[ReverseBridge] Target node successfully registered TCP control tunnel for %s from %s", ruleID, c.RemoteAddr())

	} else if cmd == "WORK_UDP" {
		// 预建立的持续性 UDP 多路复用工作流隧道 (FRP 机制)
		if tc, ok := c.(*net.TCPConn); ok {
			_ = tc.SetKeepAlive(true)
			_ = tc.SetKeepAlivePeriod(15 * time.Second)
		}

		session.udpWorkLock.Lock()
		if session.udpWorkConn != nil {
			_ = session.udpWorkConn.Close()
		}
		session.udpWorkConn = c
		session.udpWorkLock.Unlock()

		log.Printf("[ReverseBridge-UDP] Target node successfully registered UDP work tunnel for rule %s from %s", ruleID, c.RemoteAddr())

		// 启动从 Target 接收响应数据报并送回客户端的读取协程
		go session.runBridgeUDPFromTargetLoop(c)

	} else if cmd == "WORK" && len(parts) >= 4 {
		// TCP 临时工作数据通道到达
		connID := parts[3]
		session.pendingLock.Lock()
		ch, ok := session.pendingWork[connID]
		if ok {
			delete(session.pendingWork, connID)
		}
		session.pendingLock.Unlock()

		if ok && ch != nil {
			ch <- &bufferedConn{
				Conn: c,
				r:    io.MultiReader(reader, c),
			}
		} else {
			_ = c.Close()
		}
	} else {
		_ = c.Close()
	}
}

func (s *bridgeRuleSession) runBridgeUDPFromTargetLoop(c net.Conn) {
	defer c.Close()
	for {
		remoteAddrStr, data, err := readUDPPacket(c)
		if err != nil {
			s.udpWorkLock.Lock()
			if s.udpWorkConn == c {
				s.udpWorkConn = nil
			}
			s.udpWorkLock.Unlock()
			return
		}
		if s.udpListener != nil && len(data) > 0 {
			rAddr, err := net.ResolveUDPAddr("udp", remoteAddrStr)
			if err == nil {
				_, _ = s.udpListener.WriteToUDP(data, rAddr)
			}
		}
	}
}

func runBridgeServer(ctx context.Context, r v2.TunnelRule) {
	controlPort := r.ControlPort
	if controlPort <= 0 {
		controlPort = 27888
	}
	publicPort := r.ListenPort
	if publicPort <= 0 {
		publicPort = r.BridgePort
	}
	if publicPort <= 0 {
		log.Printf("[ReverseBridge] Invalid public listen port for rule %s", r.ID)
		return
	}

	proto := getEffectiveProtocol(r)

	// 1. 注册到共享控制端口 Hub (多个规则可无缝复用同一个 controlPort)
	session, err := registerBridgeSession(r, controlPort)
	if err != nil {
		log.Printf("[ReverseBridge] %v", err)
		return
	}
	defer unregisterBridgeSession(r.ID, controlPort)

	log.Printf("[ReverseBridge] Starting bridge for rule %s (%s): PublicPort=%d, ControlPort=%d", r.ID, proto, publicPort, controlPort)

	var wg sync.WaitGroup

	// 2. 启动 UDP 监听（适用于 TUIC / Hysteria 2 / UDP 端口转发）
	if proto == "udp" || proto == "both" {
		udpListener, err := net.ListenUDP("udp", &net.UDPAddr{Port: publicPort})
		if err != nil {
			log.Printf("[ReverseBridge] Failed to listen public UDP port %d for rule %s: %v", publicPort, r.ID, err)
		} else {
			session.udpListener = udpListener
			log.Printf("[ReverseBridge] Listening public UDP port %d for rule %s", publicPort, r.ID)

			go func() {
				<-ctx.Done()
				_ = udpListener.Close()
			}()

			wg.Add(1)
			go func() {
				defer wg.Done()
				session.runBridgeUDPVisitorLoop(ctx, udpListener)
			}()
		}
	}

	// 3. 启动 TCP 监听（适用于 VLESS Reality / SOCKS5 / TCP 端口转发）
	if proto == "tcp" || proto == "both" {
		pubListener, err := net.Listen("tcp", fmt.Sprintf(":%d", publicPort))
		if err != nil {
			log.Printf("[ReverseBridge] Failed to listen public TCP port %d for rule %s: %v", publicPort, r.ID, err)
		} else {
			log.Printf("[ReverseBridge] Listening public TCP port %d for rule %s", publicPort, r.ID)

			go func() {
				<-ctx.Done()
				_ = pubListener.Close()
			}()

			wg.Add(1)
			go func() {
				defer wg.Done()
				session.runBridgeTCPVisitorLoop(ctx, pubListener)
			}()
		}
	}

	<-ctx.Done()
	wg.Wait()
}

func (s *bridgeRuleSession) runBridgeUDPVisitorLoop(ctx context.Context, udpListener *net.UDPConn) {
	buf := make([]byte, 65535)
	for {
		n, remoteAddr, err := udpListener.ReadFromUDP(buf)
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
				time.Sleep(50 * time.Millisecond)
				continue
			}
		}

		s.udpWorkLock.Lock()
		work := s.udpWorkConn
		s.udpWorkLock.Unlock()

		if work != nil {
			s.udpWriteMu.Lock()
			err := writeUDPPacket(work, remoteAddr.String(), buf[:n])
			s.udpWriteMu.Unlock()
			if err != nil {
				log.Printf("[ReverseBridge-UDP] Failed to forward UDP packet from %s to target for %s: %v", remoteAddr, s.rule.ID, err)
				s.udpWorkLock.Lock()
				if s.udpWorkConn == work {
					_ = work.Close()
					s.udpWorkConn = nil
				}
				s.udpWorkLock.Unlock()
			}
		} else {
			log.Printf("[ReverseBridge-UDP] Dropped %d bytes from %s for %s: Target work tunnel not connected", n, remoteAddr, s.rule.ID)
		}
	}
}

func (s *bridgeRuleSession) runBridgeTCPVisitorLoop(ctx context.Context, pubListener net.Listener) {
	for {
		userConn, err := pubListener.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
				time.Sleep(100 * time.Millisecond)
				continue
			}
		}

		go func(visitor net.Conn) {
			s.ctrlWriteMu.Lock()
			s.ctrlLock.Lock()
			ctrl := s.activeCtrl
			s.ctrlLock.Unlock()

			if ctrl == nil {
				s.ctrlWriteMu.Unlock()
				log.Printf("[ReverseBridge] No active target connected for %s, closing visitor connection", s.rule.ID)
				_ = visitor.Close()
				return
			}

			s.connSeq++
			connID := fmt.Sprintf("%d-%d", time.Now().UnixNano(), s.connSeq)
			workCh := make(chan net.Conn, 1)

			s.pendingLock.Lock()
			s.pendingWork[connID] = workCh
			s.pendingLock.Unlock()

			// 向内网端发号施令要求其建立 TCP 数据通道
			_, err := ctrl.Write([]byte(fmt.Sprintf("REQ %s\n", connID)))
			if err != nil {
				s.ctrlLock.Lock()
				if s.activeCtrl == ctrl {
					_ = s.activeCtrl.Close()
					s.activeCtrl = nil
				}
				s.ctrlLock.Unlock()
				s.ctrlWriteMu.Unlock()

				s.pendingLock.Lock()
				delete(s.pendingWork, connID)
				s.pendingLock.Unlock()
				_ = visitor.Close()
				log.Printf("[ReverseBridge] Control connection write failed for %s: %v", s.rule.ID, err)
				return
			}
			s.ctrlWriteMu.Unlock()

			// 等待内网端响应工作通道 (最长等待 10 秒)
			select {
			case workConn := <-workCh:
				if workConn == nil {
					_ = visitor.Close()
					return
				}
				pipeConns(visitor, workConn)
			case <-time.After(10 * time.Second):
				s.pendingLock.Lock()
				delete(s.pendingWork, connID)
				s.pendingLock.Unlock()
				_ = visitor.Close()
			case <-ctx.Done():
				_ = visitor.Close()
			}
		}(userConn)
	}
}

// ==========================================
// 2. 内网端 (Target Client) 引擎
// ==========================================

func runTargetClient(ctx context.Context, r v2.TunnelRule) {
	bridgeHost := strings.TrimSpace(r.BridgeHost)
	controlPort := r.ControlPort
	if controlPort <= 0 {
		controlPort = 27888
	}

	targetHost := strings.TrimSpace(r.TargetHost)
	if targetHost == "" || r.TargetType == "local" {
		targetHost = "127.0.0.1"
	}
	targetPort := r.TargetPort
	if targetPort <= 0 {
		targetPort = r.ListenPort
	}

	remoteAddr := fmt.Sprintf("%s:%d", bridgeHost, controlPort)
	localAddr := fmt.Sprintf("%s:%d", targetHost, targetPort)
	proto := getEffectiveProtocol(r)

	log.Printf("[ReverseTarget] Starting reverse target for %s (%s): Bridge=%s, LocalTarget=%s", r.ID, proto, remoteAddr, localAddr)

	var wg sync.WaitGroup

	// 如果包含 UDP (TUIC / Hysteria 2 / UDP 端口转发)，启动预建立工作流通道的多路复用协程
	if proto == "udp" || proto == "both" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			runTargetUDPWorker(ctx, r, remoteAddr, localAddr)
		}()
	}

	// 如果包含 TCP (VLESS / SOCKS5 / TCP 端口转发)，启动 TCP 反向穿透协程
	if proto == "tcp" || proto == "both" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			runTargetTCPWorker(ctx, r, remoteAddr, localAddr)
		}()
	}

	<-ctx.Done()
	wg.Wait()
}

func runTargetTCPWorker(ctx context.Context, r v2.TunnelRule, remoteAddr, localAddr string) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		conn, err := net.DialTimeout("tcp", remoteAddr, 10*time.Second)
		if err != nil {
			log.Printf("[ReverseTarget-TCP] Failed to dial bridge %s for rule %s: %v. Retrying in 5s...", remoteAddr, r.ID, err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
				continue
			}
		}

		if tc, ok := conn.(*net.TCPConn); ok {
			_ = tc.SetKeepAlive(true)
			_ = tc.SetKeepAlivePeriod(15 * time.Second)
		}

		go func(c net.Conn) {
			<-ctx.Done()
			_ = c.Close()
		}(conn)

		// 发送 TCP AUTH 握手
		authMsg := fmt.Sprintf("AUTH %s %s\n", r.TunnelSecret, r.ID)
		_, err = conn.Write([]byte(authMsg))
		if err != nil {
			_ = conn.Close()
			time.Sleep(3 * time.Second)
			continue
		}

		reader := bufio.NewReader(conn)
		resp, err := reader.ReadString('\n')
		if err != nil || strings.TrimSpace(resp) != "OK" {
			log.Printf("[ReverseTarget-TCP] Bridge auth rejected or failed for %s: %v", r.ID, err)
			_ = conn.Close()
			time.Sleep(5 * time.Second)
			continue
		}

		log.Printf("[ReverseTarget-TCP] Successfully established TCP control tunnel to bridge %s for rule %s", remoteAddr, r.ID)

		// 循环等待公网端发号施令
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				select {
				case <-ctx.Done():
					return
				default:
					log.Printf("[ReverseTarget-TCP] Control connection disconnected for %s: %v", r.ID, err)
					_ = conn.Close()
				}
				break
			}

			line = strings.TrimSpace(line)
			parts := strings.Split(line, " ")
			if len(parts) == 2 && parts[0] == "REQ" {
				connID := parts[1]
				go handleWorkConnection(ctx, remoteAddr, localAddr, r.TunnelSecret, r.ID, connID)
			}
		}

		time.Sleep(2 * time.Second)
	}
}

type targetUDPSession struct {
	remoteAddr string
	localConn  *net.UDPConn
	lastActive time.Time
}

func runTargetUDPWorker(ctx context.Context, r v2.TunnelRule, remoteBridgeAddr, localTargetAddr string) {
	localUDPAddr, err := net.ResolveUDPAddr("udp", localTargetAddr)
	if err != nil {
		log.Printf("[ReverseTarget-UDP] Invalid local target UDP address %s for rule %s: %v", localTargetAddr, r.ID, err)
		return
	}

	log.Printf("[ReverseTarget-UDP] Starting UDP reverse worker for %s -> Bridge=%s, LocalTarget=%s", r.ID, remoteBridgeAddr, localTargetAddr)

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		conn, err := net.DialTimeout("tcp", remoteBridgeAddr, 10*time.Second)
		if err != nil {
			log.Printf("[ReverseTarget-UDP] Failed to connect bridge %s for rule %s: %v. Retrying in 5s...", remoteBridgeAddr, r.ID, err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
				continue
			}
		}

		if tc, ok := conn.(*net.TCPConn); ok {
			_ = tc.SetKeepAlive(true)
			_ = tc.SetKeepAlivePeriod(15 * time.Second)
		}

		// 注册预建立的持续性 UDP 工作流隧道 (FRP 机制)
		regMsg := fmt.Sprintf("WORK_UDP %s %s\n", r.TunnelSecret, r.ID)
		_, err = conn.Write([]byte(regMsg))
		if err != nil {
			_ = conn.Close()
			time.Sleep(3 * time.Second)
			continue
		}

		log.Printf("[ReverseTarget-UDP] Successfully established UDP work tunnel to bridge %s for rule %s", remoteBridgeAddr, r.ID)

		handleTargetUDPLoop(ctx, conn, localUDPAddr)
		_ = conn.Close()

		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

func handleTargetUDPLoop(ctx context.Context, bridgeConn net.Conn, localUDPAddr *net.UDPAddr) {
	sessions := make(map[string]*targetUDPSession)
	var sessionsMu sync.Mutex
	var writeLock sync.Mutex

	// 定时清理空闲超过 60 秒的访客 UDP 会话
	cleanTicker := time.NewTicker(15 * time.Second)
	defer cleanTicker.Stop()

	stopCh := make(chan struct{})
	defer close(stopCh)

	go func() {
		for {
			select {
			case <-stopCh:
				return
			case <-cleanTicker.C:
				sessionsMu.Lock()
				now := time.Now()
				for rAddr, sess := range sessions {
					if now.Sub(sess.lastActive) > 60*time.Second {
						_ = sess.localConn.Close()
						delete(sessions, rAddr)
					}
				}
				sessionsMu.Unlock()
			}
		}
	}()

	go func() {
		<-ctx.Done()
		_ = bridgeConn.Close()
	}()

	for {
		remoteAddrStr, data, err := readUDPPacket(bridgeConn)
		if err != nil {
			break
		}

		sessionsMu.Lock()
		sess, exists := sessions[remoteAddrStr]
		if !exists {
			localConn, err := net.DialUDP("udp", nil, localUDPAddr)
			if err != nil {
				sessionsMu.Unlock()
				log.Printf("[ReverseTarget-UDP] Failed to dial local UDP %v: %v", localUDPAddr, err)
				continue
			}

			sess = &targetUDPSession{
				remoteAddr: remoteAddrStr,
				localConn:  localConn,
				lastActive: time.Now(),
			}
			sessions[remoteAddrStr] = sess

			log.Printf("[ReverseTarget-UDP] Received visitor %s -> Forwarding to local %v (first packet %d bytes)", remoteAddrStr, localUDPAddr, len(data))

			// 异步读取本地服务的 UDP 响应并送回公网 Bridge
			go func(s *targetUDPSession, rAddr string) {
				buf := make([]byte, 65535)
				firstResp := true
				for {
					n, err := s.localConn.Read(buf)
					if err != nil {
						return
					}
					s.lastActive = time.Now()
					if firstResp {
						firstResp = false
						log.Printf("[ReverseTarget-UDP] Local service responded %d bytes for visitor %s -> Returning to bridge", n, rAddr)
					}

					writeLock.Lock()
					wErr := writeUDPPacket(bridgeConn, rAddr, buf[:n])
					writeLock.Unlock()
					if wErr != nil {
						_ = bridgeConn.Close()
						return
					}
				}
			}(sess, remoteAddrStr)
		}
		sess.lastActive = time.Now()
		sessionsMu.Unlock()

		_, _ = sess.localConn.Write(data)
	}

	sessionsMu.Lock()
	for _, sess := range sessions {
		_ = sess.localConn.Close()
	}
	sessionsMu.Unlock()
}

func handleWorkConnection(ctx context.Context, remoteAddr, localAddr, secret, ruleID, connID string) {
	// 连接本地目标服务
	localConn, err := net.DialTimeout("tcp", localAddr, 5*time.Second)
	if err != nil {
		log.Printf("[ReverseTarget] Failed to dial local target service %s: %v", localAddr, err)
		return
	}
	if tc, ok := localConn.(*net.TCPConn); ok {
		_ = tc.SetKeepAlive(true)
		_ = tc.SetKeepAlivePeriod(30 * time.Second)
	}

	// 连接公网 Bridge 的工作端口
	bridgeConn, err := net.DialTimeout("tcp", remoteAddr, 8*time.Second)
	if err != nil {
		_ = localConn.Close()
		log.Printf("[ReverseTarget] Failed to dial bridge for work conn: %v", err)
		return
	}
	if tc, ok := bridgeConn.(*net.TCPConn); ok {
		_ = tc.SetKeepAlive(true)
		_ = tc.SetKeepAlivePeriod(30 * time.Second)
	}

	// 发送 WORK 握手头
	workHeader := fmt.Sprintf("WORK %s %s %s\n", secret, ruleID, connID)
	_, err = bridgeConn.Write([]byte(workHeader))
	if err != nil {
		_ = localConn.Close()
		_ = bridgeConn.Close()
		return
	}

	// 双向无损数据搬运 (Pipe)
	pipeConns(localConn, bridgeConn)
}

func pipeConns(c1, c2 net.Conn) {
	var once sync.Once
	closeBoth := func() {
		_ = c1.Close()
		_ = c2.Close()
	}

	go func() {
		_, _ = io.Copy(c1, c2)
		once.Do(closeBoth)
	}()

	go func() {
		_, _ = io.Copy(c2, c1)
		once.Do(closeBoth)
	}()
}

// bufferedConn 包装 net.Conn，在 Read 时优先排空 bufio.Reader 缓冲区中预读的残留数据
type bufferedConn struct {
	net.Conn
	r io.Reader
}

func (b *bufferedConn) Read(p []byte) (int, error) {
	return b.r.Read(p)
}
