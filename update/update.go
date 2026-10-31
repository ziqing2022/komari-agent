// Package update handles self-updating capabilities.
package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/blang/semver"
	"github.com/rhysd/go-github-selfupdate/selfupdate"
	"github.com/ziqing2022/komari-agent/dnsresolver"
)

var ErrRestartRequired = errors.New("update installed; restart required")

var (
	CurrentVersion string = "0.0.1"
	Repo           string = "ziqing2022/komari-agent"
)

const (
	snapshotVersionPrefix = "Snapshot-"
	containerMarkerPath   = "/.komari-agent-container"
	githubAPIBaseURL      = "https://api.github.com"
)

type buildTrack int

const (
	stableTrack buildTrack = iota
	snapshotTrack
)

type githubRelease struct {
	TagName     string               `json:"tag_name"`
	Name        string               `json:"name"`
	Body        string               `json:"body"`
	Draft       bool                 `json:"draft"`
	Prerelease  bool                 `json:"prerelease"`
	HTMLURL     string               `json:"html_url"`
	PublishedAt time.Time            `json:"published_at"`
	Assets      []githubReleaseAsset `json:"assets"`
}

type githubReleaseAsset struct {
	ID                 int64  `json:"id"`
	Name               string `json:"name"`
	Size               int    `json:"size"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

type snapshotReleaseCandidate struct {
	TagName     string
	Name        string
	Body        string
	HTMLURL     string
	PublishedAt time.Time
	Asset       githubReleaseAsset
}

type selfUpdater interface {
	UpdateSelf(current semver.Version, slug string) (*selfupdate.Release, error)
	UpdateTo(release *selfupdate.Release, cmdPath string) error
}

type releaseLister func(owner, repo string) ([]githubRelease, error)
type containerCheck func() bool

// parseVersion 解析可能带有 v/V 前缀，以及预发布或构建元数据的版本字符串
func parseVersion(ver string) (semver.Version, error) {
	ver = strings.TrimPrefix(ver, "v")
	ver = strings.TrimPrefix(ver, "V")
	return semver.ParseTolerant(ver)
}

// needUpdate 判断是否需要更新
func needUpdate(current, latest semver.Version) bool {
	// 返回最新版本大于当前版本时需要更新
	return latest.Compare(current) > 0
}

func detectBuildTrack(version string) buildTrack {
	if strings.HasPrefix(version, snapshotVersionPrefix) {
		return snapshotTrack
	}
	return stableTrack
}

func expectedAssetName(goos, goarch string) string {
	name := fmt.Sprintf("komari-agent-%s-%s", goos, goarch)
	if goos == "windows" {
		name += ".exe"
	}
	return name
}

// detectEffectiveArch 决定目标更新资产的架构。
// 在 Linux 32 位 ARM 上（无论系统内核报告为 armv7l 还是 armv5tel），
// 如果 CPU 缺少硬件浮点单元（VFP），必须使用纯软浮点的 "armv5" 二进制，
// 否则执行默认 GOARM=7 的二进制会立刻触发 SIGILL（非法指令）硬件异常崩溃。
func detectEffectiveArch(goos, goarch string) string {
	if goos == "linux" && (goarch == "arm" || goarch == "armv5") {
		if lacksVFP() {
			return "armv5"
		}
	}
	return goarch
}

func lacksVFP() bool {
	data, err := os.ReadFile("/proc/cpuinfo")
	if err != nil {
		return false
	}
	content := strings.ToLower(string(data))
	return !strings.Contains(content, "vfp") && !strings.Contains(content, "neon")
}

func findReleaseAsset(release githubRelease, assetName string) (githubReleaseAsset, bool) {
	for _, asset := range release.Assets {
		if asset.Name == assetName {
			return asset, true
		}
	}
	return githubReleaseAsset{}, false
}

func selectLatestSnapshotRelease(releases []githubRelease, assetName string) (snapshotReleaseCandidate, bool) {
	var latest snapshotReleaseCandidate
	found := false

	for _, release := range releases {
		if release.Draft || !release.Prerelease || !strings.HasPrefix(release.TagName, snapshotVersionPrefix) {
			continue
		}

		asset, ok := findReleaseAsset(release, assetName)
		if !ok {
			continue
		}

		candidate := snapshotReleaseCandidate{
			TagName:     release.TagName,
			Name:        release.Name,
			Body:        release.Body,
			HTMLURL:     release.HTMLURL,
			PublishedAt: release.PublishedAt,
			Asset:       asset,
		}

		if !found ||
			candidate.PublishedAt.After(latest.PublishedAt) ||
			(candidate.PublishedAt.Equal(latest.PublishedAt) && candidate.TagName > latest.TagName) {
			latest = candidate
			found = true
		}
	}

	return latest, found
}

func selectLatestStableRelease(releases []githubRelease, currentVersion semver.Version, assetName string) (snapshotReleaseCandidate, bool) {
	var latest snapshotReleaseCandidate
	found := false
	var bestVer semver.Version

	for _, release := range releases {
		if release.Draft || release.Prerelease || strings.HasPrefix(release.TagName, snapshotVersionPrefix) {
			continue
		}

		ver, err := parseVersion(release.TagName)
		if err != nil {
			continue
		}

		if !ver.GT(currentVersion) {
			continue
		}

		asset, ok := findReleaseAsset(release, assetName)
		if !ok {
			continue
		}

		candidate := snapshotReleaseCandidate{
			TagName:     release.TagName,
			Name:        release.Name,
			Body:        release.Body,
			HTMLURL:     release.HTMLURL,
			PublishedAt: release.PublishedAt,
			Asset:       asset,
		}

		if !found || ver.GT(bestVer) || (ver.Equals(bestVer) && candidate.PublishedAt.After(latest.PublishedAt)) {
			latest = candidate
			bestVer = ver
			found = true
		}
	}

	return latest, found
}

func snapshotNeedsUpdate(currentVersion string, latest snapshotReleaseCandidate) bool {
	return currentVersion != latest.TagName
}

func isContainerAgent() bool {
	_, err := os.Stat(containerMarkerPath)
	return err == nil
}

func splitRepoSlug(slug string) (string, string, error) {
	parts := strings.Split(slug, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", fmt.Errorf("invalid repo slug %q, expected owner/name", slug)
	}
	return parts[0], parts[1], nil
}

func listGitHubReleases(owner, repo string) ([]githubRelease, error) {
	var releases []githubRelease

	for page := 1; ; page++ {
		endpoint := fmt.Sprintf(
			"%s/repos/%s/%s/releases?per_page=100&page=%d",
			githubAPIBaseURL,
			url.PathEscape(owner),
			url.PathEscape(repo),
			page,
		)
		req, err := http.NewRequest(http.MethodGet, endpoint, nil)
		if err != nil {
			return nil, fmt.Errorf("failed to create GitHub releases request: %w", err)
		}

		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("User-Agent", "komari-agent")
		if token := os.Getenv("GITHUB_TOKEN"); token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("failed to list GitHub releases: %w", err)
		}

		if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
			_ = resp.Body.Close()
			return nil, fmt.Errorf("GitHub releases API returned status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		}

		var pageReleases []githubRelease
		if err := json.NewDecoder(resp.Body).Decode(&pageReleases); err != nil {
			_ = resp.Body.Close()
			return nil, fmt.Errorf("failed to decode GitHub releases response: %w", err)
		}
		_ = resp.Body.Close()

		releases = append(releases, pageReleases...)
		if len(pageReleases) < 100 {
			return releases, nil
		}
	}
}

func currentExecutablePath() (string, error) {
	cmdPath, err := os.Executable()
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "windows" && !strings.HasSuffix(cmdPath, ".exe") {
		cmdPath += ".exe"
	}

	stat, err := os.Lstat(cmdPath)
	if err != nil {
		return "", fmt.Errorf("failed to stat %q: %w", cmdPath, err)
	}
	if stat.Mode()&os.ModeSymlink != 0 {
		resolved, err := filepath.EvalSymlinks(cmdPath)
		if err != nil {
			return "", fmt.Errorf("failed to resolve symlink %q for executable: %w", cmdPath, err)
		}
		cmdPath = resolved
	}

	return cmdPath, nil
}

func selfUpdateReleaseFromSnapshot(owner, repo string, candidate snapshotReleaseCandidate) *selfupdate.Release {
	publishedAt := candidate.PublishedAt
	return &selfupdate.Release{
		Version:           semver.Version{},
		AssetURL:          candidate.Asset.BrowserDownloadURL,
		AssetByteSize:     candidate.Asset.Size,
		AssetID:           candidate.Asset.ID,
		ValidationAssetID: -1,
		URL:               candidate.HTMLURL,
		ReleaseNotes:      candidate.Body,
		Name:              candidate.Name,
		PublishedAt:       &publishedAt,
		RepoOwner:         owner,
		RepoName:          repo,
	}
}

func DoUpdateWorks(onRestartRequired func()) {
	ticker_ := time.NewTicker(time.Duration(6) * time.Hour)
	defer ticker_.Stop()
	runScheduledUpdates(ticker_.C, CheckAndUpdate, onRestartRequired)
}

func runScheduledUpdates(ticks <-chan time.Time, check func() error, onRestartRequired func()) {
	for range ticks {
		if errors.Is(check(), ErrRestartRequired) {
			if onRestartRequired != nil {
				onRestartRequired()
			}
			return
		}
	}
}

func checkAndUpdateStable(currentSemVer semver.Version, updater selfUpdater, listReleases releaseLister) error {
	effArch := detectEffectiveArch(runtime.GOOS, runtime.GOARCH)
	// 针对无硬件浮点的 ARM 设备（如海思 Hi3535、老群晖 Kirkwood/Armada 等）：
	// 第三方自更新库只使用 GOARCH=arm，会无脑下载带硬件浮点的 komari-agent-linux-arm 导致暴毙。
	// 这里通过自定义 Release 资产匹配逻辑，精确匹配并下载对应的 komari-agent-linux-armv5。
	if effArch != runtime.GOARCH && listReleases != nil {
		owner, repo, err := splitRepoSlug(Repo)
		if err != nil {
			return err
		}
		releases, err := listReleases(owner, repo)
		if err != nil {
			return err
		}
		assetName := expectedAssetName(runtime.GOOS, effArch)
		latest, found := selectLatestStableRelease(releases, currentSemVer, assetName)
		if !found {
			log.Println("Current version is the latest:", CurrentVersion)
			return nil
		}

		cmdPath, err := currentExecutablePath()
		if err != nil {
			return fmt.Errorf("failed to resolve current executable path: %w", err)
		}

		log.Printf("Will update %s from %s to %s (%s)\n", cmdPath, CurrentVersion, latest.TagName, assetName)
		if err := updater.UpdateTo(selfUpdateReleaseFromSnapshot(owner, repo, latest), cmdPath); err != nil {
			return fmt.Errorf("failed to update to %s: %w", latest.TagName, err)
		}

		log.Printf("Successfully updated to version %s\n", latest.TagName)
		return ErrRestartRequired
	}

	latest, err := updater.UpdateSelf(currentSemVer, Repo)
	if err != nil {
		return fmt.Errorf("failed to check for updates: %v", err)
	}

	if latest.Version.Equals(currentSemVer) {
		log.Println("Current version is the latest:", CurrentVersion)
		return nil
	}
	log.Printf("Successfully updated to version %s\n", latest.Version)
	return ErrRestartRequired
}

func checkAndUpdateSnapshot(updater selfUpdater, listReleases releaseLister, isContainer containerCheck) error {
	if isContainer() {
		log.Println("Snapshot agent is running in a container; skip binary self-update. Refresh the ghcr.io image tagged 'snapshot' instead.")
		return nil
	}

	owner, repo, err := splitRepoSlug(Repo)
	if err != nil {
		return err
	}

	releases, err := listReleases(owner, repo)
	if err != nil {
		return err
	}

	assetName := expectedAssetName(runtime.GOOS, detectEffectiveArch(runtime.GOOS, runtime.GOARCH))
	latest, found := selectLatestSnapshotRelease(releases, assetName)
	if !found {
		log.Printf("No suitable snapshot release asset was found for %s. Current snapshot is considered up-to-date.", assetName)
		return nil
	}

	if !snapshotNeedsUpdate(CurrentVersion, latest) {
		log.Println("Current snapshot version is the latest:", CurrentVersion)
		return nil
	}

	cmdPath, err := currentExecutablePath()
	if err != nil {
		return fmt.Errorf("failed to resolve current executable path: %w", err)
	}

	log.Printf("Will update %s from snapshot %s to %s\n", cmdPath, CurrentVersion, latest.TagName)
	if err := updater.UpdateTo(selfUpdateReleaseFromSnapshot(owner, repo, latest), cmdPath); err != nil {
		return fmt.Errorf("failed to update to snapshot %s: %w", latest.TagName, err)
	}

	log.Printf("Successfully updated to snapshot version %s\n", latest.TagName)
	return ErrRestartRequired
}

// 检查更新并执行自动更新
func CheckAndUpdate() error {
	log.Println("Checking update...")

	http.DefaultClient = dnsresolver.GetHTTPClient(60 * time.Second)
	updater, err := selfupdate.NewUpdater(selfupdate.Config{})
	if err != nil {
		return fmt.Errorf("failed to create updater: %v", err)
	}

	if detectBuildTrack(CurrentVersion) == snapshotTrack {
		return checkAndUpdateSnapshot(updater, listGitHubReleases, isContainerAgent)
	}

	currentSemVer, err := parseVersion(CurrentVersion)
	if err != nil {
		return fmt.Errorf("failed to parse current version: %v", err)
	}

	return checkAndUpdateStable(currentSemVer, updater, listGitHubReleases)
}
