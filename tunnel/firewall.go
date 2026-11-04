package tunnel

import (
	"fmt"
	"log"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

// OpenPort 自动根据操作系统开放指定端口 (TCP / UDP)
func OpenPort(port int, protocol string) error {
	protocol = strings.ToLower(protocol)
	switch runtime.GOOS {
	case "linux":
		return openPortLinux(port, protocol)
	case "windows":
		return openPortWindows(port, protocol)
	default:
		return nil
	}
}

// ClosePort 自动关闭/移除已开放的端口规则
func ClosePort(port int, protocol string) error {
	protocol = strings.ToLower(protocol)
	switch runtime.GOOS {
	case "linux":
		return closePortLinux(port, protocol)
	case "windows":
		return closePortWindows(port, protocol)
	default:
		return nil
	}
}

// openPortLinux 优先采用通用 iptables -I INPUT 幂等插入方式放行端口，全方位兼容甲骨文云、群晖及所有常见发行版
func openPortLinux(port int, protocol string) error {
	protos := parseProtocols(protocol)
	pStr := strconv.Itoa(port)

	// 1. 优先使用通用 iptables -I INPUT 插入到最顶行（绝对覆盖并优先于底层任何 DROP / REJECT 规则生效）
	if isCommandAvailable("iptables") {
		for _, proto := range protos {
			// 先用 -C 检查是否已存在，防止重复插入堆叠
			checkCmd := exec.Command("iptables", "-C", "INPUT", "-p", proto, "--dport", pStr, "-j", "ACCEPT")
			if checkCmd.Run() != nil {
				addCmd := exec.Command("iptables", "-I", "INPUT", "-p", proto, "--dport", pStr, "-j", "ACCEPT")
				if err := addCmd.Run(); err == nil {
					log.Printf("[Firewall] iptables -I INPUT -p %s --dport %s -j ACCEPT succeeded", proto, pStr)
				}
			}
		}
	}

	// 2. 同步支持 ip6tables (IPv6 入站放行)
	if isCommandAvailable("ip6tables") {
		for _, proto := range protos {
			checkCmd := exec.Command("ip6tables", "-C", "INPUT", "-p", proto, "--dport", pStr, "-j", "ACCEPT")
			if checkCmd.Run() != nil {
				_ = exec.Command("ip6tables", "-I", "INPUT", "-p", proto, "--dport", pStr, "-j", "ACCEPT").Run()
			}
		}
	}

	// 3. 补充通知 UFW (若系统开启了 ufw)
	if isCommandAvailable("ufw") {
		for _, proto := range protos {
			cmd := exec.Command("ufw", "allow", fmt.Sprintf("%s/%s", pStr, proto))
			_ = cmd.Run()
		}
	}

	// 4. 补充通知 firewalld (若系统开启了 firewalld)
	if isCommandAvailable("firewall-cmd") {
		for _, proto := range protos {
			cmd := exec.Command("firewall-cmd", fmt.Sprintf("--add-port=%s/%s", pStr, proto), "--permanent")
			_ = cmd.Run()
		}
		_ = exec.Command("firewall-cmd", "--reload").Run()
	}

	return nil
}

func closePortLinux(port int, protocol string) error {
	protos := parseProtocols(protocol)
	pStr := strconv.Itoa(port)

	if isCommandAvailable("iptables") {
		for _, proto := range protos {
			_ = exec.Command("iptables", "-D", "INPUT", "-p", proto, "--dport", pStr, "-j", "ACCEPT").Run()
		}
	}

	if isCommandAvailable("ip6tables") {
		for _, proto := range protos {
			_ = exec.Command("ip6tables", "-D", "INPUT", "-p", proto, "--dport", pStr, "-j", "ACCEPT").Run()
		}
	}

	if isCommandAvailable("ufw") {
		for _, proto := range protos {
			_ = exec.Command("ufw", "delete", "allow", fmt.Sprintf("%s/%s", pStr, proto)).Run()
		}
	}

	if isCommandAvailable("firewall-cmd") {
		for _, proto := range protos {
			_ = exec.Command("firewall-cmd", fmt.Sprintf("--remove-port=%s/%s", pStr, proto), "--permanent").Run()
		}
		_ = exec.Command("firewall-cmd", "--reload").Run()
	}

	return nil
}

// openPortWindows 使用 netsh 打开指定端口
func openPortWindows(port int, protocol string) error {
	protos := parseProtocols(protocol)
	pStr := strconv.Itoa(port)

	for _, proto := range protos {
		ruleName := fmt.Sprintf("Komari_Tunnel_%s_%s", proto, pStr)
		// 先尝试删除同名旧规则
		_ = exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", fmt.Sprintf("name=%s", ruleName)).Run()

		cmd := exec.Command("netsh", "advfirewall", "firewall", "add", "rule",
			fmt.Sprintf("name=%s", ruleName),
			"dir=in",
			"action=allow",
			fmt.Sprintf("protocol=%s", strings.ToUpper(proto)),
			fmt.Sprintf("localport=%s", pStr),
		)
		if err := cmd.Run(); err != nil {
			log.Printf("[Firewall] Windows netsh error for port %s (%s): %v", pStr, proto, err)
		} else {
			log.Printf("[Firewall] Windows opened port %s (%s)", pStr, proto)
		}
	}
	return nil
}

func closePortWindows(port int, protocol string) error {
	protos := parseProtocols(protocol)
	pStr := strconv.Itoa(port)

	for _, proto := range protos {
		ruleName := fmt.Sprintf("Komari_Tunnel_%s_%s", proto, pStr)
		_ = exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", fmt.Sprintf("name=%s", ruleName)).Run()
	}
	return nil
}

func parseProtocols(protocol string) []string {
	protocol = strings.ToLower(strings.TrimSpace(protocol))
	if protocol == "both" || protocol == "tcp+udp" || protocol == "all" || protocol == "" {
		return []string{"tcp", "udp"}
	}
	if protocol == "udp" {
		return []string{"udp"}
	}
	return []string{"tcp"}
}

func isCommandAvailable(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}
