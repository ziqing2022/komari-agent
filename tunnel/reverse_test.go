package tunnel

import (
	"context"
	"fmt"
	"net"
	"testing"
	"time"

	v2 "github.com/ziqing2022/komari-agent/protocol/v2"
)

func TestRuleSignatureChange(t *testing.T) {
	r1 := v2.TunnelRule{
		ID:           "test-1",
		Role:         "bridge",
		ListenPort:   10443,
		ControlPort:  27888,
		TunnelSecret: "sec1",
		Enabled:      true,
	}

	sig1 := ruleSignature(r1)

	// 修改内部控制端口
	r2 := r1
	r2.ControlPort = 27889
	sig2 := ruleSignature(r2)

	if sig1 == sig2 {
		t.Fatalf("expected signatures to differ when ControlPort changes, got same: %s", sig1)
	}

	// 修改密钥
	r3 := r1
	r3.TunnelSecret = "sec2"
	sig3 := ruleSignature(r3)
	if sig1 == sig3 {
		t.Fatalf("expected signatures to differ when TunnelSecret changes")
	}

	// 相同的配置应该有相同的指纹
	r4 := r1
	sig4 := ruleSignature(r4)
	if sig1 != sig4 {
		t.Fatalf("expected same signatures for identical rules")
	}
}

func TestBridgeControlHubMultiplexing(t *testing.T) {
	// 选择一个可用的测试端口
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to bind test port: %v", err)
	}
	testPort := l.Addr().(*net.TCPAddr).Port
	l.Close()

	r1 := v2.TunnelRule{
		ID:           "rule-a",
		Role:         "bridge",
		ListenPort:   10443,
		ControlPort:  testPort,
		TunnelSecret: "secret-a",
		Enabled:      true,
	}

	r2 := v2.TunnelRule{
		ID:           "rule-b",
		Role:         "bridge",
		ListenPort:   10444,
		ControlPort:  testPort, // 相同的控制端口
		TunnelSecret: "secret-b",
		Enabled:      true,
	}

	// 1. 注册 Rule A
	s1, err := registerBridgeSession(r1, testPort)
	if err != nil {
		t.Fatalf("failed to register session 1: %v", err)
	}
	defer unregisterBridgeSession(r1.ID, testPort)

	if s1 == nil {
		t.Fatalf("expected session 1 to be non-nil")
	}

	// 2. 注册 Rule B 到相同的 ControlPort，必须成功复用（不能报 address already in use）
	s2, err := registerBridgeSession(r2, testPort)
	if err != nil {
		t.Fatalf("failed to register session 2 on same control port: %v", err)
	}
	defer unregisterBridgeSession(r2.ID, testPort)

	if s2 == nil {
		t.Fatalf("expected session 2 to be non-nil")
	}

	// 3. 测试客户端连接并使用 AUTH 指令
	hub := bridgeHubs[testPort]
	if hub == nil {
		t.Fatalf("expected hub to exist for port %d", testPort)
	}

	if hub.refCount != 2 {
		t.Fatalf("expected hub refCount to be 2, got %d", hub.refCount)
	}

	// 模拟 Rule B 客户端连接并 AUTH
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", testPort), 2*time.Second)
	if err != nil {
		t.Fatalf("failed to dial control hub: %v", err)
	}
	defer conn.Close()

	authMsg := fmt.Sprintf("AUTH %s %s\n", r2.TunnelSecret, r2.ID)
	if _, err := conn.Write([]byte(authMsg)); err != nil {
		t.Fatalf("failed to write AUTH msg: %v", err)
	}

	buf := make([]byte, 16)
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatalf("failed to read response: %v", err)
	}

	resp := string(buf[:n])
	if resp != "OK\n" {
		t.Fatalf("expected 'OK\\n', got %q", resp)
	}

	// 确认 s2 的 activeCtrl 被正确绑定，而 s1 的不受影响
	s2.ctrlLock.Lock()
	hasCtrl2 := s2.activeCtrl != nil
	s2.ctrlLock.Unlock()

	s1.ctrlLock.Lock()
	hasCtrl1 := s1.activeCtrl != nil
	s1.ctrlLock.Unlock()

	if !hasCtrl2 {
		t.Fatalf("expected s2 to have activeCtrl registered")
	}
	if hasCtrl1 {
		t.Fatalf("expected s1 to not have activeCtrl yet")
	}
}

func TestSyncReverseTunnelsHotReload(t *testing.T) {
	// 验证配置变更会触发旧规则取消与新规则拉起
	r1 := v2.TunnelRule{
		ID:           "reload-test",
		Role:         "target",
		ListenPort:   8080,
		TargetPort:   8080,
		ControlPort:  29999,
		BridgeHost:   "127.0.0.1",
		TunnelSecret: "sec1",
		Enabled:      true,
		IsReverse:    true,
	}

	SyncReverseTunnels([]v2.TunnelRule{r1})

	reverseLock.Lock()
	cancel1, ok1 := reverseCancels[r1.ID]
	sig1 := reverseSignatures[r1.ID]
	reverseLock.Unlock()

	if !ok1 || cancel1 == nil {
		t.Fatalf("expected rule to be running")
	}

	// 更改端口，再次同步
	r2 := r1
	r2.ControlPort = 30000
	SyncReverseTunnels([]v2.TunnelRule{r2})

	reverseLock.Lock()
	cancel2, ok2 := reverseCancels[r2.ID]
	sig2 := reverseSignatures[r2.ID]
	reverseLock.Unlock()

	if !ok2 || cancel2 == nil {
		t.Fatalf("expected reloaded rule to be running")
	}
	if sig1 == sig2 {
		t.Fatalf("expected signature to change")
	}

	// 清理
	StopAllReverseTunnels()
}
