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

// openPortLinux 依次尝试 ufw, firewalld, iptables
func openPortLinux(port int, protocol string) error {
	protos := parseProtocols(protocol)
	pStr := strconv.Itoa(port)

	// 1. 尝试 UFW
	if isCommandAvailable("ufw") {
		for _, proto := range protos {
			cmd := exec.Command("ufw", "allow", fmt.Sprintf("%s/%s", pStr, proto))
			if out, err := cmd.CombinedOutput(); err == nil {
				log.Printf("[Firewall] ufw allow %s/%s succeeded: %s", pStr, proto, strings.TrimSpace(string(out)))
			}
		}
		return nil
	}

	// 2. 尝试 firewalld
	if isCommandAvailable("firewall-cmd") {
		for _, proto := range protos {
			cmd := exec.Command("firewall-cmd", fmt.Sprintf("--add-port=%s/%s", pStr, proto), "--permanent")
			_ = cmd.Run()
		}
		_ = exec.Command("firewall-cmd", "--reload").Run()
		log.Printf("[Firewall] firewalld opened port %s (%s)", pStr, protocol)
		return nil
	}

	// 3. 兜底尝试 iptables
	if isCommandAvailable("iptables") {
		for _, proto := range protos {
			// 先检查是否存在以防重复添加
			checkCmd := exec.Command("iptables", "-C", "INPUT", "-p", proto, "--dport", pStr, "-j", "ACCEPT")
			if checkCmd.Run() != nil {
				addCmd := exec.Command("iptables", "-I", "INPUT", "1", "-p", proto, "--dport", pStr, "-j", "ACCEPT")
				_ = addCmd.Run()
			}
		}
		log.Printf("[Firewall] iptables rule inserted for port %s (%s)", pStr, protocol)
		return nil
	}

	return nil
}

func closePortLinux(port int, protocol string) error {
	protos := parseProtocols(protocol)
	pStr := strconv.Itoa(port)

	if isCommandAvailable("ufw") {
		for _, proto := range protos {
			_ = exec.Command("ufw", "delete", "allow", fmt.Sprintf("%s/%s", pStr, proto)).Run()
		}
		return nil
	}

	if isCommandAvailable("firewall-cmd") {
		for _, proto := range protos {
			_ = exec.Command("firewall-cmd", fmt.Sprintf("--remove-port=%s/%s", pStr, proto), "--permanent").Run()
		}
		_ = exec.Command("firewall-cmd", "--reload").Run()
		return nil
	}

	if isCommandAvailable("iptables") {
		for _, proto := range protos {
			_ = exec.Command("iptables", "-D", "INPUT", "-p", proto, "--dport", pStr, "-j", "ACCEPT").Run()
		}
		return nil
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
