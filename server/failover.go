package server

import (
	"encoding/json"
	"errors"
	"log"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/ziqing2022/komari-agent/utils"
)

type FailoverManager struct {
	mu                  sync.RWMutex
	endpoints           []string
	currentIndex        int
	consecutiveFailures int
	failoverThreshold   int
	lastAuthError       time.Time
	authFailureCount    int
	backoffDuration     time.Duration
}

var Failover = &FailoverManager{
	failoverThreshold: 2, // 连续失败 2 次网络故障触发向下一个备用端点漂移
	backoffDuration:   30 * time.Second,
}

// InitEndpoints 初始化主备端点池
func (fm *FailoverManager) InitEndpoints(primary string, backups []string) {
	fm.mu.Lock()
	defer fm.mu.Unlock()

	endpointMap := make(map[string]bool)
	var list []string

	add := func(raw string) {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			return
		}
		if !strings.HasPrefix(trimmed, "http://") && !strings.HasPrefix(trimmed, "https://") &&
			!strings.HasPrefix(trimmed, "ws://") && !strings.HasPrefix(trimmed, "wss://") {
			trimmed = "http://" + trimmed
		}
		trimmed = strings.TrimRight(trimmed, "/")
		if !endpointMap[trimmed] {
			endpointMap[trimmed] = true
			list = append(list, trimmed)
		}
	}

	// 兼容逗号分隔的主地址
	for _, ep := range strings.Split(primary, ",") {
		add(ep)
	}
	for _, ep := range backups {
		for _, sub := range strings.Split(ep, ",") {
			add(sub)
		}
	}

	if len(list) == 0 {
		list = []string{"http://127.0.0.1:25774"}
	}
	fm.endpoints = list
	fm.currentIndex = 0
	fm.consecutiveFailures = 0
	fm.authFailureCount = 0

	log.Printf("[Failover] Initialized endpoint pool (%d total): active=%s, list=%v", len(list), list[0], list)
}

// GetActiveEndpoint 获取当前活跃端点（HTTP 格式）
func (fm *FailoverManager) GetActiveEndpoint() string {
	fm.mu.RLock()
	defer fm.mu.RUnlock()
	if len(fm.endpoints) == 0 {
		return "http://127.0.0.1:25774"
	}
	return fm.endpoints[fm.currentIndex]
}

// GetActiveWebSocketEndpoint 获取当前活跃端点的 WebSocket 完整 URL
func (fm *FailoverManager) GetActiveWebSocketEndpoint() string {
	base := strings.TrimSuffix(fm.GetActiveEndpoint(), "/")
	websocketEndpoint := base + "/api/clients/v2/rpc?token=" + flags.Token
	websocketEndpoint = "ws" + strings.TrimPrefix(websocketEndpoint, "http")
	if convertedEndpoint, err := utils.ConvertIDNToASCII(websocketEndpoint); err == nil {
		return convertedEndpoint
	} else {
		log.Printf("Warning: Failed to convert WebSocket IDN to ASCII: %v", err)
	}
	return websocketEndpoint
}

// OnSuccess 连接成功回调：执行“粘性提升（Sticky Promotion）”并落盘持久化
func (fm *FailoverManager) OnSuccess(usedEndpoint string) {
	fm.mu.Lock()
	defer fm.mu.Unlock()

	fm.consecutiveFailures = 0
	fm.authFailureCount = 0
	fm.backoffDuration = 30 * time.Second

	// 若当前成功的不是首选端点，将该端点晋升为第 0 位（粘性固定）
	if fm.currentIndex != 0 && len(fm.endpoints) > 1 {
		successEP := fm.endpoints[fm.currentIndex]
		log.Printf("[Failover] Promoting working backup endpoint to primary: %s", successEP)
		newEndpoints := []string{successEP}
		for i, ep := range fm.endpoints {
			if i != fm.currentIndex {
				newEndpoints = append(newEndpoints, ep)
			}
		}
		fm.endpoints = newEndpoints
		fm.currentIndex = 0
		flags.Endpoint = successEP
		flags.Endpoints = newEndpoints

		// 异步持久化到本地 config.json
		go fm.saveConfigToFile()
	}
}

// OnFailure 连接失败分析与故障转移判断
func (fm *FailoverManager) OnFailure(err error) (isAuthError bool, sleepDuration time.Duration) {
	fm.mu.Lock()
	defer fm.mu.Unlock()

	// 1. 检查是否为 401 / 403 鉴权错误：绝不切换域名，仅执行指数退避与日志限流
	if httpErr, ok := err.(*httpStatusError); ok && (httpErr.StatusCode == 401 || httpErr.StatusCode == 403) {
		fm.authFailureCount++
		now := time.Now()
		// 首次打印完整告警，后续每 30 分钟或每 50 次仅打印一次汇总，防止内存日志爆满
		if fm.authFailureCount == 1 || now.Sub(fm.lastAuthError) > 30*time.Minute || fm.authFailureCount%50 == 0 {
			log.Printf("[Auth] 401 Unauthorized: Invalid or expired token (suppressed %d logs). Backing off for %v", fm.authFailureCount, fm.backoffDuration)
			fm.lastAuthError = now
		}

		sleep := fm.backoffDuration
		if fm.backoffDuration < 300*time.Second {
			fm.backoffDuration = time.Duration(float64(fm.backoffDuration) * 1.5)
			if fm.backoffDuration > 300*time.Second {
				fm.backoffDuration = 300 * time.Second
			}
		}
		return true, sleep
	}

	// 2. 检查底层网络故障码与网关 52x 错误
	isDeadRoute := false
	if isNetworkDead(err) {
		isDeadRoute = true
	} else if httpErr, ok := err.(*httpStatusError); ok && httpErr.StatusCode >= 520 && httpErr.StatusCode <= 530 {
		isDeadRoute = true
	}

	if isDeadRoute {
		fm.consecutiveFailures++
		if fm.consecutiveFailures >= fm.failoverThreshold && len(fm.endpoints) > 1 {
			oldEP := fm.endpoints[fm.currentIndex]
			fm.currentIndex = (fm.currentIndex + 1) % len(fm.endpoints)
			targetEP := fm.endpoints[fm.currentIndex]
			fm.consecutiveFailures = 0
			log.Printf("[Failover] Route failure detected on %s (%v). Drifting to next endpoint: %s (pool index %d/%d)",
				oldEP, err, targetEP, fm.currentIndex+1, len(fm.endpoints))
		}
	}

	reconnectWait := time.Duration(flags.ReconnectInterval) * time.Second
	if reconnectWait < 2*time.Second {
		reconnectWait = 3 * time.Second
	}
	return false, reconnectWait
}

// SyncEndpoints 由主控端动态下发最新主备地址列表并同步本地
func (fm *FailoverManager) SyncEndpoints(newList []string) {
	if len(newList) == 0 {
		return
	}
	fm.mu.Lock()
	defer fm.mu.Unlock()

	endpointMap := make(map[string]bool)
	var validList []string
	for _, ep := range newList {
		trimmed := strings.TrimRight(strings.TrimSpace(ep), "/")
		if trimmed != "" && !endpointMap[trimmed] {
			endpointMap[trimmed] = true
			validList = append(validList, trimmed)
		}
	}
	if len(validList) > 0 {
		fm.endpoints = validList
		fm.currentIndex = 0
		flags.Endpoint = validList[0]
		flags.Endpoints = validList
		go fm.saveConfigToFile()
		log.Printf("[Failover] Synchronized %d active endpoints from master: %v", len(validList), validList)
	}
}

// isNetworkDead 捕获 DNS 解析失败、超时、RST 阻断等底层网络故障
func isNetworkDead(err error) bool {
	if err == nil {
		return false
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true // 三次握手超时或 I/O 超时
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return true // 域名解析挂掉 / NXDOMAIN
	}
	errStr := strings.ToLower(err.Error())
	if strings.Contains(errStr, "connection refused") ||
		strings.Contains(errStr, "connection reset by peer") ||
		strings.Contains(errStr, "no route to host") ||
		strings.Contains(errStr, "tls handshake timeout") ||
		strings.Contains(errStr, "broken pipe") ||
		strings.Contains(errStr, "i/o timeout") {
		return true
	}
	return false
}

// saveConfigToFile 将当前最新的首选端点和列表持久化至本地配置文件
func (fm *FailoverManager) saveConfigToFile() {
	if flags.ConfigFile == "" {
		return
	}
	data, err := json.MarshalIndent(flags, "", "  ")
	if err != nil {
		log.Printf("[Failover] Failed to marshal config for saving: %v", err)
		return
	}
	if err := os.WriteFile(flags.ConfigFile, data, 0644); err != nil {
		log.Printf("[Failover] Failed to save updated config to %s: %v", flags.ConfigFile, err)
	} else {
		log.Printf("[Failover] Successfully persisted failover config to %s", flags.ConfigFile)
	}
}
