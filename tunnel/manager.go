package tunnel

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	v2 "github.com/ziqing2022/komari-agent/protocol/v2"
)

var (
	mgrLock      sync.Mutex
	currentCmd   *exec.Cmd
	appliedRules []v2.TunnelRule
)

// SingBoxConfig Sing-box 配置模型
type SingBoxConfig struct {
	Log struct {
		Level     string `json:"level"`
		Timestamp bool   `json:"timestamp"`
	} `json:"log"`
	Inbounds  []map[string]any `json:"inbounds"`
	Outbounds []map[string]any `json:"outbounds"`
}

// ApplyTunnelRules 应用并启动/重载隧道与代理节点配置
func ApplyTunnelRules(rules []v2.TunnelRule) (int, error) {
	mgrLock.Lock()
	defer mgrLock.Unlock()

	activeCount := 0
	for _, r := range rules {
		if r.Enabled {
			activeCount++
		}
	}

	// 1. 同步管理防火墙端口放行/回收
	syncFirewallPorts(appliedRules, rules)
	appliedRules = rules

	// 2. 同步运行/更新原生反向穿透引擎 (Bridge 公网端 或 Target 内网端)
	SyncReverseTunnels(rules)

	// 3. 计算常规 Sing-box 规则 (公网直连节点，或内网节点需要本地 Sing-box 监听的协议节点)
	regularActiveCount := 0
	for _, r := range rules {
		if r.Enabled && strings.ToLower(r.Role) != "bridge" {
			ruleType := strings.ToLower(strings.TrimSpace(r.RuleType))
			if ruleType != "forward" || !r.IsReverse {
				regularActiveCount++
			}
		}
	}

	// 如果没有开启的常规规则，停止 sing-box 进程
	if regularActiveCount == 0 {
		stopProcess()
		log.Println("[Tunnel] No active regular sing-box rules, sing-box stopped.")
		return activeCount, nil
	}

	// 2. 确保 Sing-box 核心就绪 (全平台架构适配)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	binPath, err := EnsureSingBoxInstalled(ctx)
	if err != nil {
		return 0, fmt.Errorf("failed to prepare sing-box: %w", err)
	}

	// 3. 先停止旧的 Sing-box 进程释放端口，再执行端口占用预检与配置生成
	stopProcess()

	// 4. 渲染 sing-box 多协议配置（自动预检端口冲突并跳过被占用端口）
	cfg := generateSingBoxConfig(rules)
	if len(cfg.Inbounds) == 0 {
		log.Println("[Tunnel] All configured inbounds are unavailable or conflicting. Sing-box stopped.")
		return activeCount, nil
	}
	cfgBytes, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return 0, fmt.Errorf("failed to encode config: %w", err)
	}

	cfgPath := filepath.Join(getRuntimeDir(), "sing-box-tunnel.json")
	if err := os.WriteFile(cfgPath, cfgBytes, 0644); err != nil {
		return 0, fmt.Errorf("failed to write config file: %w", err)
	}

	cmd := exec.Command(binPath, "run", "-c", cfgPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("failed to start sing-box process: %w", err)
	}

	currentCmd = cmd
	log.Printf("[Tunnel] Sing-box running with %d active rules (PID: %d)", activeCount, cmd.Process.Pid)

	// 异步监听进程意外退出
	go func(c *exec.Cmd) {
		err := c.Wait()
		mgrLock.Lock()
		if currentCmd == c {
			currentCmd = nil
			log.Printf("[Tunnel] Sing-box process exited: %v", err)
		}
		mgrLock.Unlock()
	}(cmd)

	return activeCount, nil
}

func stopProcess() {
	if currentCmd != nil && currentCmd.Process != nil {
		log.Println("[Tunnel] Stopping existing sing-box process...")
		if runtime.GOOS == "windows" {
			_ = currentCmd.Process.Kill()
		} else {
			_ = currentCmd.Process.Signal(os.Interrupt)
			time.Sleep(200 * time.Millisecond)
			if currentCmd != nil {
				_ = currentCmd.Process.Kill()
			}
		}
		currentCmd = nil
	}
}

func generateSingBoxConfig(rules []v2.TunnelRule) *SingBoxConfig {
	cfg := &SingBoxConfig{}
	cfg.Log.Level = "warn"
	cfg.Log.Timestamp = true
	cfg.Outbounds = []map[string]any{
		{"type": "direct", "tag": "direct-out"},
	}

	for i, r := range rules {
		if !r.Enabled || r.ListenPort <= 0 || strings.ToLower(r.Role) == "bridge" {
			continue
		}

		ruleType := strings.ToLower(strings.TrimSpace(r.RuleType))
		if ruleType == "" {
			ruleType = "forward"
		}
		// 纯端口转发反代由原生 reverse 引擎托管
		if ruleType == "forward" && r.IsReverse {
			continue
		}

		tag := fmt.Sprintf("in-%d-%d", i, r.ListenPort)
		proto := getEffectiveProtocol(r)

		// 端口冲突预检自动跳过：防止已被系统或第三方程序占用的端口导致 sing-box 崩溃
		checkHost := ""
		listenAddr := "::"
		if r.IsReverse && strings.ToLower(r.Role) != "bridge" {
			checkHost = "127.0.0.1"
			listenAddr = "127.0.0.1" // 跨机反代节点仅在本地监听，避免暴露公网
		}

		if !checkPortAvailable(checkHost, r.ListenPort, proto) {
			log.Printf("[Tunnel] WARNING: Port %d (%s) is already in use! Auto-bypassing rule %q to protect process", r.ListenPort, proto, r.Name)
			continue
		}

		switch ruleType {
		case "vless":
			// VLESS + REALITY
			sni := strings.TrimSpace(r.SNI)
			if sni == "" {
				sni = "gateway.icloud.com"
			}
			flow := "xtls-rprx-vision"
			shortIDs := []string{}
			if r.ShortID != "" {
				shortIDs = append(shortIDs, r.ShortID)
			}

			inbound := map[string]any{
				"type":        "vless",
				"tag":         tag,
				"listen":      listenAddr,
				"listen_port": r.ListenPort,
				"users": []map[string]any{
					{
						"uuid": r.UUID,
						"flow": flow,
					},
				},
				"tls": map[string]any{
					"enabled":     true,
					"server_name": sni,
					"reality": map[string]any{
						"enabled": true,
						"handshake": map[string]any{
							"server":      sni,
							"server_port": 443,
						},
						"private_key": r.PrivateKey,
						"short_id":    shortIDs,
					},
				},
			}
			cfg.Inbounds = append(cfg.Inbounds, inbound)

		case "tuic":
			// TUIC v5 (QUIC/UDP)
			sni := strings.TrimSpace(r.SNI)
			if sni == "" {
				sni = "gateway.icloud.com"
			}
			certPath, keyPath := ensureSelfSignedCert()
			inbound := map[string]any{
				"type":        "tuic",
				"tag":         tag,
				"listen":      listenAddr,
				"listen_port": r.ListenPort,
				"users": []map[string]any{
					{"uuid": r.UUID, "password": r.Password},
				},
				"congestion_control":    "bbr",
				"tls": map[string]any{
					"enabled":          true,
					"server_name":      sni,
					"certificate_path": certPath,
					"key_path":          keyPath,
					"alpn":             []string{"h3"},
				},
			}
			cfg.Inbounds = append(cfg.Inbounds, inbound)

		case "socks5":
			// SOCKS5 代理
			inbound := map[string]any{
				"type":        "socks",
				"tag":         tag,
				"listen":      listenAddr,
				"listen_port": r.ListenPort,
			}
			if r.Password != "" {
				user := r.Username
				if user == "" {
					user = "komari"
				}
				inbound["users"] = []map[string]any{
					{"username": user, "password": r.Password},
				}
			}
			cfg.Inbounds = append(cfg.Inbounds, inbound)

		case "shadowsocks":
			// Shadowsocks 2022 / AEAD
			method := r.Method
			if method == "" {
				method = "2022-blake3-aes-128-gcm"
			}
			inbound := map[string]any{
				"type":        "shadowsocks",
				"tag":         tag,
				"listen":      listenAddr,
				"listen_port": r.ListenPort,
				"network":     "tcp",
				"method":      method,
				"password":    r.Password,
			}
			cfg.Inbounds = append(cfg.Inbounds, inbound)

		case "trojan":
			// Trojan
			sni := strings.TrimSpace(r.SNI)
			if sni == "" {
				sni = "gateway.icloud.com"
			}
			certPath, keyPath := ensureSelfSignedCert()
			inbound := map[string]any{
				"type":        "trojan",
				"tag":         tag,
				"listen":      listenAddr,
				"listen_port": r.ListenPort,
				"users": []map[string]any{
					{"password": r.Password},
				},
				"tls": map[string]any{
					"enabled":          true,
					"server_name":      sni,
					"certificate_path": certPath,
					"key_path":          keyPath,
				},
			}
			cfg.Inbounds = append(cfg.Inbounds, inbound)

		case "hysteria2":
			// Hysteria 2 (UDP/QUIC)
			sni := strings.TrimSpace(r.SNI)
			if sni == "" {
				sni = "gateway.icloud.com"
			}
			certPath, keyPath := ensureSelfSignedCert()
			inbound := map[string]any{
				"type":                    "hysteria2",
				"tag":                     tag,
				"listen":                  listenAddr,
				"listen_port":             r.ListenPort,
				"ignore_client_bandwidth": true,
				"users": []map[string]any{
					{"password": r.Password},
				},
				"tls": map[string]any{
					"enabled":          true,
					"server_name":      sni,
					"certificate_path": certPath,
					"key_path":          keyPath,
				},
			}
			if r.ObfsPassword != "" {
				inbound["obfs"] = map[string]any{
					"type":     "salamander",
					"password": r.ObfsPassword,
				}
			}
			cfg.Inbounds = append(cfg.Inbounds, inbound)

		default:
			// "forward" - 基础端口转发
			targetHost := r.TargetHost
			if r.TargetType == "local" || strings.TrimSpace(targetHost) == "" {
				targetHost = "127.0.0.1"
			}
			targetPort := r.TargetPort
			if targetPort <= 0 {
				targetPort = r.ListenPort
			}

			inbound := map[string]any{
				"type":             "direct",
				"tag":              tag,
				"listen":           listenAddr,
				"listen_port":      r.ListenPort,
				"override_address": targetHost,
				"override_port":    targetPort,
			}

			if proto == "udp" {
				inbound["network"] = "udp"
			} else if proto == "tcp" {
				inbound["network"] = "tcp"
			}
			cfg.Inbounds = append(cfg.Inbounds, inbound)
		}
	}

	return cfg
}

func getEffectiveProtocol(r v2.TunnelRule) string {
	ruleType := strings.ToLower(strings.TrimSpace(r.RuleType))
	if ruleType == "hysteria2" || ruleType == "tuic" {
		return "udp"
	}
	if ruleType == "socks5" || ruleType == "shadowsocks" || ruleType == "vless" || ruleType == "trojan" {
		return "tcp"
	}
	proto := strings.ToLower(strings.TrimSpace(r.Protocol))
	if proto == "" {
		return "tcp"
	}
	return proto
}

func checkPortAvailable(host string, port int, proto string) bool {
	if port <= 0 || port > 65535 {
		return false
	}
	if proto == "both" {
		return checkPortAvailable(host, port, "tcp") && checkPortAvailable(host, port, "udp")
	}
	addr := fmt.Sprintf("%s:%d", host, port)
	if proto == "udp" {
		uAddr, err := net.ResolveUDPAddr("udp", addr)
		if err != nil {
			return false
		}
		conn, err := net.ListenUDP("udp", uAddr)
		if err != nil {
			return false
		}
		_ = conn.Close()
		return true
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

func ensureSelfSignedCert() (string, string) {
	certDir := filepath.Join(getRuntimeDir(), "certs")
	_ = os.MkdirAll(certDir, 0755)
	certPath := filepath.Join(certDir, "server.crt")
	keyPath := filepath.Join(certDir, "server.key")

	if _, err := os.Stat(certPath); err == nil {
		if _, err := os.Stat(keyPath); err == nil {
			return certPath, keyPath
		}
	}

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Printf("[Tunnel] Failed to generate ECDSA key for self-signed cert: %v", err)
		return "", ""
	}

	serialNumberLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serialNumber, _ := rand.Int(rand.Reader, serialNumberLimit)

	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization: []string{"Komari Agent"},
			CommonName:   "komari.proxy",
		},
		NotBefore:             time.Now().Add(-1 * time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour), // 10 years
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		DNSNames:              []string{"localhost", "komari.proxy", "gateway.icloud.com", "www.apple.com", "bing.com"},
	}

	derBytes, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		log.Printf("[Tunnel] Failed to create self-signed certificate: %v", err)
		return "", ""
	}

	certOut, err := os.Create(certPath)
	if err == nil {
		_ = pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: derBytes})
		_ = certOut.Close()
	}

	b, err := x509.MarshalECPrivateKey(priv)
	if err == nil {
		keyOut, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
		if err == nil {
			_ = pem.Encode(keyOut, &pem.Block{Type: "EC PRIVATE KEY", Bytes: b})
			_ = keyOut.Close()
		}
	}

	return certPath, keyPath
}

func syncFirewallPorts(oldRules, newRules []v2.TunnelRule) {
	oldMap := make(map[int]v2.TunnelRule)
	for _, r := range oldRules {
		if r.Enabled && r.AutoOpenFirewall {
			if r.IsReverse && strings.ToLower(r.Role) == "target" {
				continue // 内网端无需入站端口
			}
			oldMap[r.ListenPort] = r
			if r.IsReverse && strings.ToLower(r.Role) == "bridge" && r.ControlPort > 0 {
				oldMap[r.ControlPort] = r
			}
		}
	}

	newMap := make(map[int]v2.TunnelRule)
	for _, r := range newRules {
		if r.Enabled && r.AutoOpenFirewall {
			if r.IsReverse && strings.ToLower(r.Role) == "target" {
				continue // 内网端无需入站端口
			}
			newMap[r.ListenPort] = r
			if r.IsReverse && strings.ToLower(r.Role) == "bridge" {
				ctrlPort := r.ControlPort
				if ctrlPort <= 0 {
					ctrlPort = 27888
				}
				newMap[ctrlPort] = r
			}
		}
	}

	// 回收不再需要的端口
	for port, r := range oldMap {
		if _, exists := newMap[port]; !exists {
			proto := getEffectiveProtocol(r)
			log.Printf("[Firewall] Closing port %d (%s)...", port, proto)
			_ = ClosePort(port, proto)
		}
	}

	// 开放新增的端口
	for port, r := range newMap {
		if _, exists := oldMap[port]; !exists {
			proto := getEffectiveProtocol(r)
			log.Printf("[Firewall] Opening port %d (%s)...", port, proto)
			_ = OpenPort(port, proto)
		}
	}
}
