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
	reverseLock sync.Mutex
	reverseCancels = make(map[string]context.CancelFunc)
)

// SyncReverseTunnels 根据下发的规则同步运行反向穿透 (Bridge 公网端 或 Target 内网端)
func SyncReverseTunnels(rules []v2.TunnelRule) {
	reverseLock.Lock()
	defer reverseLock.Unlock()

	activeRuleIDs := make(map[string]bool)

	for _, r := range rules {
		if !r.Enabled || !r.IsReverse {
			continue
		}
		activeRuleIDs[r.ID] = true

		// 如果已经在运行，先不重复启动
		if _, exists := reverseCancels[r.ID]; exists {
			continue
		}

		ctx, cancel := context.WithCancel(context.Background())
		reverseCancels[r.ID] = cancel

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
	}
}

// ==========================================
// 1. 公网端 (Bridge Server) 引擎
// ==========================================

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

	log.Printf("[ReverseBridge] Starting bridge for rule %s: PublicPort=%d, ControlPort=%d", r.ID, publicPort, controlPort)

	// 监听内网端连接的控制端口
	ctrlListener, err := net.Listen("tcp", fmt.Sprintf(":%d", controlPort))
	if err != nil {
		log.Printf("[ReverseBridge] Failed to listen control port %d: %v", controlPort, err)
		return
	}
	defer ctrlListener.Close()

	// 监听外部访客访问的公网业务端口
	pubListener, err := net.Listen("tcp", fmt.Sprintf(":%d", publicPort))
	if err != nil {
		log.Printf("[ReverseBridge] Failed to listen public port %d: %v", publicPort, err)
		return
	}
	defer pubListener.Close()

	var (
		activeCtrlConn net.Conn
		ctrlLock       sync.Mutex
		ctrlWriteMu    sync.Mutex
		pendingWork    = make(map[string]chan net.Conn)
		pendingLock    sync.Mutex
		connSeq        uint64
	)

	// 退出清理
	go func() {
		<-ctx.Done()
		ctrlListener.Close()
		pubListener.Close()
		ctrlLock.Lock()
		if activeCtrlConn != nil {
			activeCtrlConn.Close()
		}
		ctrlLock.Unlock()
	}()

	// 接收内网客户端的控制/工作连接
	go func() {
		for {
			conn, err := ctrlListener.Accept()
			if err != nil {
				select {
				case <-ctx.Done():
					return
				default:
					time.Sleep(100 * time.Millisecond)
					continue
				}
			}

			go func(c net.Conn) {
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

				// 认证密钥与规则匹配
				if r.TunnelSecret != "" && secret != r.TunnelSecret {
					log.Printf("[ReverseBridge] Invalid auth secret from %s", c.RemoteAddr())
					c.Close()
					return
				}
				if ruleID != r.ID {
					c.Close()
					return
				}

				if cmd == "AUTH" {
					if tc, ok := c.(*net.TCPConn); ok {
						_ = tc.SetKeepAlive(true)
						_ = tc.SetKeepAlivePeriod(15 * time.Second)
					}

					// 控制连接建立
					ctrlLock.Lock()
					if activeCtrlConn != nil {
						activeCtrlConn.Close()
					}
					activeCtrlConn = c
					ctrlLock.Unlock()

					_, _ = c.Write([]byte("OK\n"))
					log.Printf("[ReverseBridge] Target node successfully registered control tunnel for %s from %s", r.ID, c.RemoteAddr())

				} else if cmd == "WORK" && len(parts) >= 4 {
					// 工作数据通道到达
					connID := parts[3]
					pendingLock.Lock()
					ch, ok := pendingWork[connID]
					if ok {
						delete(pendingWork, connID)
					}
					pendingLock.Unlock()

					if ok && ch != nil {
						// 封装 bufferedConn，排空 bufio.Reader 预读缓冲区中未消费的字节，防止首包/Banner丢失
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
			}(conn)
		}
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
			ctrlWriteMu.Lock()
			ctrlLock.Lock()
			ctrl := activeCtrlConn
			ctrlLock.Unlock()

			if ctrl == nil {
				ctrlWriteMu.Unlock()
				log.Printf("[ReverseBridge] No active target connected for %s, closing visitor connection", r.ID)
				visitor.Close()
				return
			}

			connSeq++
			connID := fmt.Sprintf("%d-%d", time.Now().UnixNano(), connSeq)
			workCh := make(chan net.Conn, 1)

			pendingLock.Lock()
			pendingWork[connID] = workCh
			pendingLock.Unlock()

			// 向内网端发号施令要求其建立数据通道（在 ctrlWriteMu 互斥锁保护下串行写入）
			_, err := ctrl.Write([]byte(fmt.Sprintf("REQ %s\n", connID)))
			if err != nil {
				ctrlLock.Lock()
				if activeCtrlConn == ctrl {
					_ = activeCtrlConn.Close()
					activeCtrlConn = nil
				}
				ctrlLock.Unlock()
				ctrlWriteMu.Unlock()

				pendingLock.Lock()
				delete(pendingWork, connID)
				pendingLock.Unlock()
				visitor.Close()
				log.Printf("[ReverseBridge] Control connection write failed for %s, closed zombie conn: %v", r.ID, err)
				return
			}
			ctrlWriteMu.Unlock()

			// 等待内网端响应工作通道 (最长等待 10 秒)
			select {
			case workConn := <-workCh:
				if workConn == nil {
					visitor.Close()
					return
				}
				pipeConns(visitor, workConn)
			case <-time.After(10 * time.Second):
				pendingLock.Lock()
				delete(pendingWork, connID)
				pendingLock.Unlock()
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
				log.Printf("[ReverseTarget] Control connection disconnected for %s: %v", r.ID, err)
				conn.Close()
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
