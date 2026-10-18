package tunnel

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
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

	// 如果没有开启的规则，停止 sing-box 进程
	if activeCount == 0 {
		stopProcess()
		log.Println("[Tunnel] No active rules, sing-box stopped.")
		return 0, nil
	}

	// 2. 确保 Sing-box 核心就绪 (全平台架构适配)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	binPath, err := EnsureSingBoxInstalled(ctx)
	if err != nil {
		return 0, fmt.Errorf("failed to prepare sing-box: %w", err)
	}

	// 3. 渲染 sing-box 多协议配置
	cfg := generateSingBoxConfig(rules)
	cfgBytes, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return 0, fmt.Errorf("failed to encode config: %w", err)
	}

	cfgPath := filepath.Join(getRuntimeDir(), "sing-box-tunnel.json")
	if err := os.WriteFile(cfgPath, cfgBytes, 0644); err != nil {
		return 0, fmt.Errorf("failed to write config file: %w", err)
	}

	// 4. 重启/拉起 sing-box 进程
	stopProcess()

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
		if !r.Enabled || r.ListenPort <= 0 {
			continue
		}

		tag := fmt.Sprintf("in-%d-%d", i, r.ListenPort)
		ruleType := strings.ToLower(strings.TrimSpace(r.RuleType))
		if ruleType == "" {
			ruleType = "forward"
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
				"listen":      "::",
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

		case "socks5":
			// SOCKS5 代理
			inbound := map[string]any{
				"type":        "socks",
				"tag":         tag,
				"listen":      "::",
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
				"listen":      "::",
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
			inbound := map[string]any{
				"type":        "trojan",
				"tag":         tag,
				"listen":      "::",
				"listen_port": r.ListenPort,
				"users": []map[string]any{
					{"password": r.Password},
				},
				"tls": map[string]any{
					"enabled":     true,
					"server_name": sni,
				},
			}
			cfg.Inbounds = append(cfg.Inbounds, inbound)

		case "hysteria2":
			// Hysteria 2 (UDP/QUIC)
			sni := strings.TrimSpace(r.SNI)
			if sni == "" {
				sni = "gateway.icloud.com"
			}
			inbound := map[string]any{
				"type":        "hysteria2",
				"tag":         tag,
				"listen":      "::",
				"listen_port": r.ListenPort,
				"users": []map[string]any{
					{"password": r.Password},
				},
				"tls": map[string]any{
					"enabled":     true,
					"server_name": sni,
				},
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
				"type":          "direct",
				"tag":           tag,
				"listen":        "::",
				"listen_port":   r.ListenPort,
				"override_host": targetHost,
				"override_port": targetPort,
			}

			proto := strings.ToLower(strings.TrimSpace(r.Protocol))
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
	if ruleType == "hysteria2" {
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

func syncFirewallPorts(oldRules, newRules []v2.TunnelRule) {
	oldMap := make(map[int]v2.TunnelRule)
	for _, r := range oldRules {
		if r.Enabled && r.AutoOpenFirewall {
			oldMap[r.ListenPort] = r
		}
	}

	newMap := make(map[int]v2.TunnelRule)
	for _, r := range newRules {
		if r.Enabled && r.AutoOpenFirewall {
			newMap[r.ListenPort] = r
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
