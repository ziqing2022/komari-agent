package tunnel

import (
	"bufio"
	"context"
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
	return fmt.Sprintf("%s|%s|%d|%d|%d|%d|%s|%s|%s|%s|%t",
		r.ID, role, r.ListenPort, r.BridgePort, r.ControlPort, r.TargetPort,
		r.TargetHost, r.TargetType, r.BridgeHost, r.TunnelSecret, r.Enabled,
	)
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
			session.activeCtrl.Close()
			session.activeCtrl = nil
		}
		session.ctrlLock.Unlock()

		session.pendingLock.Lock()
		for _, ch := range session.pendingWork {
			close(ch)
		}
		session.pendingWork = make(map[string]chan net.Conn)
		session.pendingLock.Unlock()
	}
	remaining := hub.refCount
	hub.mu.Unlock()

	if remaining <= 0 {
		if hub.cancel != nil {
			hub.cancel()
		}
		if hub.listener != nil {
			hub.listener.Close()
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
	c.SetDeadline(time.Now().Add(10 * time.Second))
	reader := bufio.NewReader(c)
	line, err := reader.ReadString('\n')
	if err != nil {
		c.Close()
		return
	}
	c.SetDeadline(time.Time{})

	line = strings.TrimSpace(line)
	parts := strings.Split(line, " ")
	if len(parts) < 3 {
		c.Close()
		return
	}

	cmd := parts[0]
	secret := parts[1]
	ruleID := parts[2]

	session := hub.getSession(ruleID)
	if session == nil {
		log.Printf("[ReverseBridge] Rejecting connection for unregistered rule %s from %s", ruleID, c.RemoteAddr())
		c.Close()
		return
	}

	// 密码认证（若规则配置了密钥则严格比对）
	if session.rule.TunnelSecret != "" && secret != session.rule.TunnelSecret {
		log.Printf("[ReverseBridge] Invalid auth secret for rule %s from %s", ruleID, c.RemoteAddr())
		c.Close()
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
			session.activeCtrl.Close()
		}
		session.activeCtrl = c
		session.ctrlLock.Unlock()

		_, _ = c.Write([]byte("OK\n"))
		log.Printf("[ReverseBridge] Target node successfully registered control tunnel for %s from %s", ruleID, c.RemoteAddr())

	} else if cmd == "WORK" && len(parts) >= 4 {
		// 工作数据通道到达
		connID := parts[3]
		session.pendingLock.Lock()
		ch, ok := session.pendingWork[connID]
		if ok {
			delete(session.pendingWork, connID)
		}
		session.pendingLock.Unlock()

		if ok && ch != nil {
			// 封装 bufferedConn，排空 bufio.Reader 预读缓冲区中未消费的字节，防止首包丢失
			ch <- &bufferedConn{
				Conn: c,
				r:    io.MultiReader(reader, c),
			}
		} else {
			c.Close()
		}
	} else {
		c.Close()
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

	// 1. 注册到共享控制端口 Hub (多个规则可无缝复用同一个 controlPort)
	session, err := registerBridgeSession(r, controlPort)
	if err != nil {
		log.Printf("[ReverseBridge] %v", err)
		return
	}
	defer unregisterBridgeSession(r.ID, controlPort)

	// 2. 监听外部访客访问的公网业务端口
	pubListener, err := net.Listen("tcp", fmt.Sprintf(":%d", publicPort))
	if err != nil {
		log.Printf("[ReverseBridge] Failed to listen public port %d for rule %s: %v", publicPort, r.ID, err)
		return
	}
	defer pubListener.Close()

	log.Printf("[ReverseBridge] Starting bridge for rule %s: PublicPort=%d, ControlPort=%d", r.ID, publicPort, controlPort)

	go func() {
		<-ctx.Done()
		pubListener.Close()
	}()

	// 接收公网外部访客连接
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
			session.ctrlWriteMu.Lock()
			session.ctrlLock.Lock()
			ctrl := session.activeCtrl
			session.ctrlLock.Unlock()

			if ctrl == nil {
				session.ctrlWriteMu.Unlock()
				log.Printf("[ReverseBridge] No active target connected for %s, closing visitor connection", r.ID)
				visitor.Close()
				return
			}

			session.connSeq++
			connID := fmt.Sprintf("%d-%d", time.Now().UnixNano(), session.connSeq)
			workCh := make(chan net.Conn, 1)

			session.pendingLock.Lock()
			session.pendingWork[connID] = workCh
			session.pendingLock.Unlock()

			// 向内网端发号施令要求其建立数据通道（在 ctrlWriteMu 互斥锁保护下串行写入）
			_, err := ctrl.Write([]byte(fmt.Sprintf("REQ %s\n", connID)))
			if err != nil {
				session.ctrlLock.Lock()
				if session.activeCtrl == ctrl {
					_ = session.activeCtrl.Close()
					session.activeCtrl = nil
				}
				session.ctrlLock.Unlock()
				session.ctrlWriteMu.Unlock()

				session.pendingLock.Lock()
				delete(session.pendingWork, connID)
				session.pendingLock.Unlock()
				visitor.Close()
				log.Printf("[ReverseBridge] Control connection write failed for %s, closed zombie conn: %v", r.ID, err)
				return
			}
			session.ctrlWriteMu.Unlock()

			// 等待内网端响应工作通道 (最长等待 10 秒)
			select {
			case workConn := <-workCh:
				if workConn == nil {
					visitor.Close()
					return
				}
				pipeConns(visitor, workConn)
			case <-time.After(10 * time.Second):
				session.pendingLock.Lock()
				delete(session.pendingWork, connID)
				session.pendingLock.Unlock()
				visitor.Close()
				log.Printf("[ReverseBridge] Work connection timeout for connID: %s", connID)
			case <-ctx.Done():
				visitor.Close()
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

	log.Printf("[ReverseTarget] Starting reverse target for %s: Bridge=%s, LocalTarget=%s", r.ID, remoteAddr, localAddr)

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// 1. 主动建立控制长连接
		conn, err := net.DialTimeout("tcp", remoteAddr, 10*time.Second)
		if err != nil {
			log.Printf("[ReverseTarget] Failed to dial bridge %s for rule %s: %v. Retrying in 5s...", remoteAddr, r.ID, err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
				continue
			}
		}

		// 开启 TCP KeepAlive 防止 NAT 映射超时失效
		if tc, ok := conn.(*net.TCPConn); ok {
			_ = tc.SetKeepAlive(true)
			_ = tc.SetKeepAlivePeriod(15 * time.Second)
		}

		// 退出清理保障：当上下文取消时即刻断开长连接以结束阻塞
		go func(c net.Conn) {
			<-ctx.Done()
			_ = c.Close()
		}(conn)

		// 2. 发送认证消息
		authMsg := fmt.Sprintf("AUTH %s %s\n", r.TunnelSecret, r.ID)
		_, err = conn.Write([]byte(authMsg))
		if err != nil {
			conn.Close()
			time.Sleep(3 * time.Second)
			continue
		}

		reader := bufio.NewReader(conn)
		resp, err := reader.ReadString('\n')
		if err != nil || strings.TrimSpace(resp) != "OK" {
			log.Printf("[ReverseTarget] Bridge auth rejected or failed: %v", err)
			conn.Close()
			time.Sleep(5 * time.Second)
			continue
		}

		log.Printf("[ReverseTarget] Successfully established control tunnel to bridge %s for rule %s", remoteAddr, r.ID)

		// 3. 循环等待公网端发号施令
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				select {
				case <-ctx.Done():
					return
				default:
					log.Printf("[ReverseTarget] Control connection disconnected for %s: %v", r.ID, err)
					conn.Close()
				}
				break
			}

			line = strings.TrimSpace(line)
			parts := strings.Split(line, " ")
			if len(parts) == 2 && parts[0] == "REQ" {
				connID := parts[1]
				// 收到新访客信号，异步建立工作流管道
				go handleWorkConnection(ctx, remoteAddr, localAddr, r.TunnelSecret, r.ID, connID)
			}
		}

		time.Sleep(2 * time.Second)
	}
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
		localConn.Close()
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
		localConn.Close()
		bridgeConn.Close()
		return
	}

	// 双向无损数据搬运 (Pipe)
	pipeConns(localConn, bridgeConn)
}

func pipeConns(c1, c2 net.Conn) {
	var once sync.Once
	closeBoth := func() {
		c1.Close()
		c2.Close()
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
