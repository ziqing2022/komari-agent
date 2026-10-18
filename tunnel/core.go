package tunnel

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	singBoxVersion = "1.11.4"
	githubRepo     = "SagerNet/sing-box"
)

// MapArchToSingbox 将系统架构精准映射到 sing-box release 命名规范
// 严格处理：x86_64, amd64, 386, arm64, armv5, armv6, armv7, loong64, riscv64 等
func MapArchToSingbox(goarch string) (string, error) {
	arch := strings.ToLower(strings.TrimSpace(goarch))
	switch arch {
	case "amd64", "x86_64", "x64", "x86-64":
		return "amd64", nil
	case "386", "i386", "x86":
		return "386", nil
	case "arm64", "aarch64":
		return "arm64", nil
	case "arm", "armv7", "armv7l", "armv6", "armv6l":
		return "armv7", nil
	case "armv5", "armv5l":
		return "armv5", nil
	case "loong64", "loongarch64":
		return "loong64", nil
	case "riscv64":
		return "riscv64", nil
	case "s390x":
		return "s390x", nil
	case "mips":
		return "mips-softfloat", nil
	default:
		return "", fmt.Errorf("unsupported arch for sing-box: %s", goarch)
	}
}

// GetBinaryPath 获取本机 sing-box 可执行文件路径
func GetBinaryPath() string {
	execDir := getRuntimeDir()
	binName := "sing-box"
	if runtime.GOOS == "windows" {
		binName += ".exe"
	}
	return filepath.Join(execDir, binName)
}

func getRuntimeDir() string {
	// 优先在当前可执行文件同级或独立配置目录下存放
	exePath, err := os.Executable()
	if err == nil {
		return filepath.Dir(exePath)
	}
	return "."
}

// EnsureSingBoxInstalled 检查本地是否存在 sing-box，不存在则自动从 GitHub (含加速镜像) 拉取解压
func EnsureSingBoxInstalled(ctx context.Context) (string, error) {
	binPath := GetBinaryPath()
	if fileExists(binPath) {
		return binPath, nil
	}

	targetArch, err := MapArchToSingbox(runtime.GOARCH)
	if err != nil {
		return "", err
	}

	goos := runtime.GOOS
	var ext string
	if goos == "windows" {
		ext = ".zip"
	} else {
		ext = ".tar.gz"
	}

	archiveName := fmt.Sprintf("sing-box-%s-%s-%s%s", singBoxVersion, goos, targetArch, ext)
	log.Printf("[Sing-box] Core missing, downloading %s...", archiveName)

	// 多镜像源回退策略
	mirrors := []string{
		fmt.Sprintf("https://github.com/%s/releases/download/v%s/%s", githubRepo, singBoxVersion, archiveName),
		fmt.Sprintf("https://ghfast.top/https://github.com/%s/releases/download/v%s/%s", githubRepo, singBoxVersion, archiveName),
		fmt.Sprintf("https://ghproxy.net/https://github.com/%s/releases/download/v%s/%s", githubRepo, singBoxVersion, archiveName),
	}

	var downloadErr error
	for _, downloadURL := range mirrors {
		log.Printf("[Sing-box] Trying download from: %s", downloadURL)
		downloadErr = downloadAndExtract(ctx, downloadURL, archiveName, binPath)
		if downloadErr == nil {
			log.Printf("[Sing-box] Successfully installed to %s", binPath)
			_ = os.Chmod(binPath, 0755)
			return binPath, nil
		}
		log.Printf("[Sing-box] Download mirror failed: %v", downloadErr)
	}

	return "", fmt.Errorf("all download mirrors failed: %w", downloadErr)
}

func downloadAndExtract(ctx context.Context, downloadURL, archiveName, targetBinPath string) error {
	req, err := http.NewRequestWithContext(ctx, "GET", downloadURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "komari-agent/1.2")

	client := &http.Client{Timeout: 90 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	tmpFile := targetBinPath + ".downloading"
	_ = os.Remove(tmpFile)

	// 处理 .tar.gz
	if strings.HasSuffix(archiveName, ".tar.gz") {
		gzr, err := gzip.NewReader(resp.Body)
		if err != nil {
			return err
		}
		defer gzr.Close()

		tr := tar.NewReader(gzr)
		for {
			hdr, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
			if hdr.Typeflag == tar.TypeReg && (filepath.Base(hdr.Name) == "sing-box" || filepath.Base(hdr.Name) == "sing-box.exe") {
				out, err := os.OpenFile(tmpFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
				if err != nil {
					return err
				}
				if _, err := io.Copy(out, tr); err != nil {
					out.Close()
					_ = os.Remove(tmpFile)
					return err
				}
				out.Close()
				return os.Rename(tmpFile, targetBinPath)
			}
		}
		return fmt.Errorf("sing-box binary not found in archive")
	}

	// 简易直接流式写入
	out, err := os.OpenFile(tmpFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, resp.Body); err != nil {
		_ = os.Remove(tmpFile)
		return err
	}
	return os.Rename(tmpFile, targetBinPath)
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}
