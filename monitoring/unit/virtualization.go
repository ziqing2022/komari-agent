package monitoring

import (
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"

	cpuid "github.com/klauspost/cpuid/v2"
)

// ContainerInfo 包含容器环境详细信息
type ContainerInfo struct {
	IsContainer bool   `json:"is_container"`
	Runtime     string `json:"runtime"`      // docker, podman, lxc, kubernetes, container, none
	ContainerID string `json:"container_id"` // 容器短ID或长ID
	CgroupVer   string `json:"cgroup_ver"`   // v1, v2
}

// GetContainerInfo 获取容器环境检测结果
func GetContainerInfo() ContainerInfo {
	info := ContainerInfo{
		IsContainer: false,
		Runtime:     "none",
		CgroupVer:   detectCgroupVersion(),
	}

	ct, id := detectContainerWithID()
	if ct != "" {
		info.IsContainer = true
		info.Runtime = ct
		info.ContainerID = id
	}
	return info
}

func detectCgroupVersion() string {
	if _, err := os.Stat("/sys/fs/cgroup/cgroup.controllers"); err == nil {
		return "v2"
	}
	if _, err := os.Stat("/sys/fs/cgroup/memory"); err == nil {
		return "v1"
	}
	return "unknown"
}

func Virtualized() string {
	// Windows: use CPUID to detect hypervisor presence and vendor.
	if runtime.GOOS == "windows" {
		return detectByCPUID()
	}

	// 优先检测容器环境（如 Docker、Podman、LXC、K8s），避免在 VM 宿主机中运行时误报宿主机底层 Hypervisor
	if ct := detectContainer(); ct != "" {
		return ct
	}

	// Linux/others: prefer systemd-detect-virt if available; fallback to CPUID.
	if out, err := exec.Command("systemd-detect-virt").Output(); err == nil {
		virt := strings.TrimSpace(string(out))
		if virt != "" {
			return virt
		}
	}

	// Fallback (any OS): CPUID hypervisor bit and vendor mapping.
	return detectByCPUID()
}

// detectByCPUID uses cpuid to check if running under a hypervisor and maps vendor to a common name.
func detectByCPUID() string {
	if !cpuid.CPU.VM() {
		// Align with systemd-detect-virt for bare metal.
		return "none"
	}
	vendor := strings.ToLower(cpuid.CPU.HypervisorVendorString)

	vendorMap := map[string][]string{
		"kvm":       {"kvm"},
		"microsoft": {"microsoft", "hyper-v", "msvm", "mshyperv"},
		"vmware":    {"vmware"},
		"xen":       {"xen"},
		"bhyve":     {"bhyve"},
		"qemu":      {"qemu"},
		"parallels": {"parallels"},
		"oracle":    {"oracle", "virtualbox", "vbox"},
		"acrn":      {"acrn"},
	}

	for name, keys := range vendorMap {
		for _, key := range keys {
			if vendor == key || strings.Contains(vendor, key) {
				return name
			}
		}
	}
	if vendor != "" {
		return vendor
	}
	return "virtualized"
}

// detectContainer attempts to detect common Linux container environments.
func detectContainer() string {
	ct, _ := detectContainerWithID()
	return ct
}

func detectContainerWithID() (string, string) {
	// 1. Definite file markers
	if fileExists("/.dockerenv") {
		id := extractContainerID()
		return "docker", id
	}
	if fileExists("/run/.containerenv") { // podman / CRI-O
		id := extractContainerID()
		if s := parseCgroupForContainer(); s != "" {
			return s, id
		}
		return "podman", id
	}

	// 2. 检查系统环境变量中的 container 标记
	if envContainer := os.Getenv("container"); envContainer != "" {
		return strings.ToLower(envContainer), extractContainerID()
	}

	// 3. cgroup based detection
	if s := parseCgroupForContainer(); s != "" {
		return s, extractContainerID()
	}

	if fileExists("/dev/.lxc-boot-id") {
		return "lxc", ""
	}
	if fileExists("/.komari-agent-container") {
		return "container", ""
	}

	// 4. cgroups v2 辅助探测: 检查 mountinfo 中的 docker / containerd / overlay
	if isDockerMountinfo() {
		return "docker", extractContainerID()
	}

	return "", ""
}

func isDockerMountinfo() bool {
	data, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return false
	}
	content := string(data)
	if strings.Contains(content, "/docker/containers/") || strings.Contains(content, "/docker/overlay2/") {
		return true
	}
	return false
}

func extractContainerID() string {
	// 尝试从 cgroup 中提取 64 位十六进制 ID
	for _, path := range []string{"/proc/self/cgroup", "/proc/1/cgroup"} {
		if data, err := os.ReadFile(path); err == nil {
			idPattern := regexp.MustCompile(`(?m)[0-9a-f]{64}`)
			if match := idPattern.FindString(string(data)); match != "" {
				return match[:12] // 返回常用的 12 字符短 ID
			}
		}
	}
	// 尝试从 /proc/self/mountinfo 中提取
	if data, err := os.ReadFile("/proc/self/mountinfo"); err == nil {
		idPattern := regexp.MustCompile(`/docker/containers/([0-9a-f]{64})`)
		if matches := idPattern.FindStringSubmatch(string(data)); len(matches) > 1 {
			return matches[1][:12]
		}
	}
	// Docker 默认将主机名设为前 12 位短 ID
	if hostname, err := os.Hostname(); err == nil {
		hexPattern := regexp.MustCompile(`^[0-9a-f]{12}$`)
		if hexPattern.MatchString(strings.ToLower(hostname)) {
			return hostname
		}
	}
	return ""
}

func fileExists(p string) bool {
	if st, err := os.Stat(p); err == nil && !st.IsDir() {
		return true
	}
	return false
}

func parseCgroupForContainer() string {
	data, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return ""
	}
	lower := strings.ToLower(string(data))

	// Precompile (once) regex patterns for common container runtimes.
	// Patterns target leaf elements referencing container IDs instead of any occurrence of runtime name to reduce false positives.
	var (
		dockerIDPattern    = regexp.MustCompile(`(?m)/(?:docker|cri-containerd)[/-]([0-9a-f]{12,64})(?:\.scope)?$`)
		dockerScopePattern = regexp.MustCompile(`(?m)/docker-[0-9a-f]{12,64}\.scope$`)
		kubePattern        = regexp.MustCompile(`(?m)/kubepods[/.].*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}).*`) // pod UID
		podmanPattern      = regexp.MustCompile(`(?m)/(?:libpod|podman)[-_]([0-9a-f]{12,64})(?:\.scope)?$`)
		lxcPattern         = regexp.MustCompile(`(?m)/lxc/[^/]+$`)
		crioPattern        = regexp.MustCompile(`(?m)/crio-[0-9a-f]{12,64}\.scope$`)
	)

	// Order: specific runtime before generic container.
	if dockerIDPattern.FindStringIndex(lower) != nil || dockerScopePattern.FindStringIndex(lower) != nil {
		return "docker"
	}
	if podmanPattern.FindStringIndex(lower) != nil {
		return "podman"
	}
	if crioPattern.FindStringIndex(lower) != nil {
		return "container" // CRI-O generic
	}
	if kubePattern.FindStringIndex(lower) != nil {
		return "kubernetes"
	}
	if lxcPattern.FindStringIndex(lower) != nil {
		return "lxc"
	}

	return ""
}
