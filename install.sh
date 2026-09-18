#!/usr/bin/env bash
# ==============================================================================
# Komari Agent Installation Script (Custom Privacy & Anti-Leak Edition)
# Repository: ziqing2022/komari-agent
# Features:
#   - Downloads release binary directly from ziqing2022/komari-agent
#   - Writes credentials securely to /opt/komari-agent/config.json (chmod 0600)
#   - Runs via systemd with NO CLI parameters (completely hides token/url in top/ps)
#   - Automatically suppresses SSH login MOTD banner (~/.hushlogin)
# ==============================================================================

set -e

# Default settings
GITHUB_REPO="ziqing2022/komari-agent"
INSTALL_DIR="/opt/komari-agent"
BIN_NAME="komari-agent"
SERVICE_NAME="komari-agent"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check root privilege
if [ "$(id -u)" != "0" ]; then
    log_error "This script must be run as root. Please use sudo or switch to root."
    exit 1
fi

# Parsing command line parameters
ENDPOINT=""
TOKEN=""
INTERVAL="3"
AUTO_DISCOVERY=""
DISABLE_AUTO_UPDATE="false"
DISABLE_WEB_SSH="false"
IGNORE_UNSAFE_CERT="false"
DISABLE_MOTD="true"

print_help() {
    cat << EOF
Usage: bash install.sh [OPTIONS]

Options:
    -e, --endpoint <URL>        Komari server endpoint (e.g., https://komari.example.com)
    -t, --token <TOKEN>         Komari agent authentication token
    -i, --interval <SECONDS>    Report interval in seconds (default: 3)
    -a, --auto-discovery <KEY>  Auto discovery secret key
    --no-motd-suppress          Do not suppress SSH login MOTD prompts
    -h, --help                  Show this help message

Examples:
    curl -sSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/install.sh | bash -s -- -e "https://monitor.example.com" -t "your-token"
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -e|--endpoint)
            ENDPOINT="$2"
            shift 2
            ;;
        -t|--token)
            TOKEN="$2"
            shift 2
            ;;
        -i|--interval)
            INTERVAL="$2"
            shift 2
            ;;
        -a|--auto-discovery)
            AUTO_DISCOVERY="$2"
            shift 2
            ;;
        --no-motd-suppress)
            DISABLE_MOTD="false"
            shift
            ;;
        -h|--help)
            print_help
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            print_help
            exit 1
            ;;
    esac
done

# Interactive input if missing
if [ -z "$ENDPOINT" ]; then
    read -rp "Please enter Komari endpoint (e.g., https://komari.example.com): " ENDPOINT
fi

if [ -z "$TOKEN" ] && [ -z "$AUTO_DISCOVERY" ]; then
    read -rp "Please enter Agent Token: " TOKEN
fi

if [ -z "$ENDPOINT" ]; then
    log_error "Endpoint cannot be empty!"
    exit 1
fi

# Architecture detection
ARCH="$(uname -m)"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"

case "$ARCH" in
    x86_64|amd64)
        ARCH="amd64"
        ;;
    aarch64|arm64)
        ARCH="arm64"
        ;;
    armv7l|armv6l|arm)
        ARCH="arm"
        ;;
    i386|i686)
        ARCH="386"
        ;;
    loongarch64)
        ARCH="loong64"
        ;;
    *)
        log_error "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

TARGET_BINARY="komari-agent-${OS}-${ARCH}"
log_info "Detected OS: ${OS}, Arch: ${ARCH} (Target binary: ${TARGET_BINARY})"

# Create installation directory
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Download binary from ziqing2022/komari-agent release
DOWNLOAD_URL="https://github.com/${GITHUB_REPO}/releases/latest/download/${TARGET_BINARY}"
log_info "Downloading binary from: ${DOWNLOAD_URL}"

if command -v curl >/dev/null 2>&1; then
    if ! curl -fSL --retry 3 "${DOWNLOAD_URL}" -o "${BIN_NAME}"; then
        log_warn "Download latest release failed. Attempting fallback or check repository releases at: https://github.com/${GITHUB_REPO}/releases"
        # If binary already existed locally or backup exists
        if [ ! -f "${BIN_NAME}" ]; then
            log_error "Failed to download binary from ${DOWNLOAD_URL}."
            exit 1
        fi
    fi
elif command -v wget >/dev/null 2>&1; then
    if ! wget -q --tries=3 "${DOWNLOAD_URL}" -O "${BIN_NAME}"; then
        log_warn "Download latest release failed via wget."
        if [ ! -f "${BIN_NAME}" ]; then
            log_error "Failed to download binary from ${DOWNLOAD_URL}."
            exit 1
        fi
    fi
else
    log_error "Neither curl nor wget found. Please install curl or wget first."
    exit 1
fi

chmod +x "${BIN_NAME}"

# Write configuration file config.json (CRITICAL: prevents top/ps token leakage)
log_info "Creating secure config.json (0600 mode) to prevent top/ps credential exposure..."
cat << EOF > "${INSTALL_DIR}/config.json"
{
  "endpoint": "${ENDPOINT}",
  "token": "${TOKEN}",
  "interval": ${INTERVAL},
  "auto_discovery_key": "${AUTO_DISCOVERY}",
  "disable_auto_update": ${DISABLE_AUTO_UPDATE},
  "disable_web_ssh": ${DISABLE_WEB_SSH},
  "ignore_unsafe_cert": ${IGNORE_UNSAFE_CERT},
  "disable_motd": ${DISABLE_MOTD}
}
EOF
chmod 600 "${INSTALL_DIR}/config.json"

# Suppress MOTD login banners if enabled
if [ "$DISABLE_MOTD" = "true" ]; then
    log_info "Suppressing SSH login MOTD welcome messages..."
    touch /root/.hushlogin
    touch ~/.hushlogin 2>/dev/null || true
    # If user directory exists
    for udir in /home/*; do
        if [ -d "$udir" ]; then
            touch "$udir/.hushlogin" 2>/dev/null || true
            chown --reference="$udir" "$udir/.hushlogin" 2>/dev/null || true
        fi
    done
    log_success "MOTD suppression applied via ~/.hushlogin"
fi

# Configure and install systemd service
if command -v systemctl >/dev/null 2>&1; then
    log_info "Configuring systemd service (/etc/systemd/system/${SERVICE_NAME}.service)..."
    cat << EOF > /etc/systemd/system/${SERVICE_NAME}.service
[Unit]
Description=Komari Agent Service (ziqing2022/komari-agent)
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
# Starts WITHOUT passing sensitive command-line parameters (token/endpoint)
# All configurations are loaded directly from config.json to hide them from 'top' and 'ps'
ExecStart=${INSTALL_DIR}/${BIN_NAME} --config ${INSTALL_DIR}/config.json
Restart=always
RestartSec=5
KillMode=process
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable "${SERVICE_NAME}"
    systemctl restart "${SERVICE_NAME}"

    log_success "Komari Agent service started and enabled successfully!"
    log_info "Service status check: systemctl status ${SERVICE_NAME}"
    log_info "Notice: When running 'top' or 'ps aux | grep komari-agent', no sensitive token or URL will appear!"
else
    log_warn "systemd not detected. You can start the agent manually in the background without parameters:"
    echo "  nohup ${INSTALL_DIR}/${BIN_NAME} --config ${INSTALL_DIR}/config.json > /dev/null 2>&1 &"
fi

echo ""
echo "=================================================================="
echo -e "${GREEN}Komari Agent (ziqing2022/komari-agent) installed successfully!${NC}"
echo "=================================================================="
echo " - Repository: https://github.com/${GITHUB_REPO}"
echo " - Installation Path: ${INSTALL_DIR}"
echo " - Config File: ${INSTALL_DIR}/config.json (permissions: 0600)"
echo " - Process Privacy: No sensitive credentials exposed in 'top' or 'ps'"
echo " - MOTD Prompt: Disabled via ~/.hushlogin"
echo "=================================================================="
