#!/usr/bin/env bash
# ============================================================================
# Aelix Studio WebUI — One-Click Installation Script
# ============================================================================
# Usage:
#   curl -fsSL https://github.com/handochan/aelix-studio/releases/latest/download/install-aelix-studio-web.sh | bash
#   # Or specify version:
#   VERSION=1.0.0 bash install-aelix-studio-web.sh
#   # Or install to custom directory:
#   INSTALL_DIR=/opt/aelix-studio-web bash install-aelix-studio-web.sh
# ============================================================================

set -euo pipefail

# ─── Default Configuration ──────────────────────────────────────────────────
VERSION="${VERSION:-__VERSION__}"
# Release packaging stamps this placeholder with the version of the assets.
INSTALL_DIR="${INSTALL_DIR:-${HOME}/.local/share/aelix-studio-web}"
BIN_DIR="${BIN_DIR:-${HOME}/.local/bin}"
MIRROR="${MIRROR:-https://github.com/handochan/aelix-studio/releases/download}"
CREATE_SYMLINK="${CREATE_SYMLINK:-1}"
UPDATE_PATH="${UPDATE_PATH:-1}"
TEMP_DIR=""
EXTRACT_TEMP=""
INSTALL_LOCK=""

# ─── Color Definitions ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# ─── Helper Functions ───────────────────────────────────────────────────────
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[✓]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[✗]${NC} $*" >&2; }
die()     { error "$*"; exit 1; }

banner() {
    echo -e "${CYAN}${BOLD}"
    echo "  ╔══════════════════════════════════════════════╗"
    echo "  ║     Aelix Studio WebUI Installer                  ║"
    echo "  ╚══════════════════════════════════════════════╝"
    echo -e "${NC}"
}

# ─── Parse Command-Line Arguments ───────────────────────────────────────────
parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --version)
                VERSION="$2"
                shift 2
                ;;
            --mirror)
                MIRROR="$2"
                shift 2
                ;;
            --install-dir)
                INSTALL_DIR="$2"
                shift 2
                ;;
            --no-symlink)
                CREATE_SYMLINK=0
                shift
                ;;
            --no-path)
                UPDATE_PATH=0
                shift
                ;;
            --help)
                show_help
                exit 0
                ;;
            *)
                warn "Unknown option: $1"
                show_help
                exit 1
                ;;
        esac
    done
}

show_help() {
    cat <<EOF
Usage: install-aelix-studio-web.sh [OPTIONS]

Options:
  --version <version>       Specify version to install (default: latest or CI-embedded)
  --mirror <url>            Specify mirror URL (default: GitHub releases)
  --install-dir <path>      Specify installation directory (default: ~/.local/share/aelix-studio-web)
  --no-symlink              Do not create symlink in ~/.local/bin
  --no-path                 Do not add PATH to shell profile
  --help                    Show this help message

Environment Variables:
  VERSION                   Version to install (same as --version)
  INSTALL_DIR               Installation directory (same as --install-dir)
  MIRROR                    Mirror URL (same as --mirror)

Examples:
  # Install latest version
  curl -fsSL https://github.com/handochan/aelix-studio/releases/latest/download/install-aelix-studio-web.sh | bash

  # Install specific version
  VERSION=1.0.0 bash install-aelix-studio-web.sh

  # Install to custom directory
  INSTALL_DIR=/opt/aelix-studio-web bash install-aelix-studio-web.sh

  # Use local file mirror (for offline installation)
  MIRROR=file:///path/to/releases bash install-aelix-studio-web.sh
EOF
}

# ─── Core Functions ────────────────────────────────────────────────────────
detect_platform_arch() {
    local os_type="$(uname -s)"
    local machine="$(uname -m)"

    # Map OS type
    case "$os_type" in
        Darwin)
            PLATFORM="darwin"
            ;;
        Linux)
            PLATFORM="linux"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            PLATFORM="win"
            ;;
        *)
            die "Unsupported OS: $os_type (only Darwin, Linux, Windows supported)"
            ;;
    esac

    # Map architecture
    case "$machine" in
        x86_64|amd64)
            ARCH="x86_64"
            ;;
        aarch64|arm64)
            ARCH="arm64"
            ;;
        *)
            die "Unsupported architecture: $machine (only x86_64/amd64 and aarch64/arm64 supported)"
            ;;
    esac

    info "Detected platform: ${BOLD}${PLATFORM}-${ARCH}${NC}"

    if [[ "$PLATFORM" == win && "$ARCH" != x86_64 ]]; then
        die "Only Windows x86_64 is packaged"
    fi
    EXECUTABLE="aelix-studio-web"
    if [[ "$PLATFORM" == win ]]; then
        EXECUTABLE="${EXECUTABLE}.exe"
    fi
}

resolve_version() {
    if [[ "$VERSION" == latest || "$VERSION" == __*__ ]]; then
        info "Resolving latest version from GitHub API..."

        if command -v curl &>/dev/null; then
            VERSION=$(curl -fsSL "https://api.github.com/repos/handochan/aelix-studio/releases/latest" \
                | grep '"tag_name"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/')
        elif command -v wget &>/dev/null; then
            VERSION=$(wget -qO- "https://api.github.com/repos/handochan/aelix-studio/releases/latest" \
                | grep '"tag_name"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/')
        else
            die "curl or wget is required to resolve version. Please install curl or wget."
        fi

        if [[ -z "$VERSION" ]]; then
            die "Failed to resolve latest version. Please specify version manually: VERSION=1.0.0 bash $0"
        fi

        info "Latest version: ${BOLD}v${VERSION}${NC}"
    else
        info "Using specified version: ${BOLD}v${VERSION}${NC}"
    fi

    if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$ ]]; then
        die "Invalid release version: $VERSION"
    fi

    # Match the packer and the release tag, including Beta prereleases.
    TARBALL_NAME="aelix-studio-web-${VERSION}-${PLATFORM}-${ARCH}.tar.gz"
    CHECKSUM_NAME="${TARBALL_NAME}.sha256"
}

download_tarball() {
    # Create temp directory
    TEMP_DIR="$(mktemp -d)"
    TARBALL_PATH="${TEMP_DIR}/${TARBALL_NAME}"
    CHECKSUM_PATH="${TEMP_DIR}/${CHECKSUM_NAME}"

    # Build download URL
    # MIRROR formats:
    #   - GitHub: https://github.com/handochan/aelix-studio/releases/download
    #   - file: file:///path/to/releases
    if [[ "$MIRROR" == file://* ]]; then
        # Local file mirror (for offline installation or testing)
        local base_path="${MIRROR#file://}"
        TARBALL_URL="file://${base_path}/v${VERSION}/${TARBALL_NAME}"
        CHECKSUM_URL="file://${base_path}/v${VERSION}/${CHECKSUM_NAME}"
    else
        # GitHub releases
        TARBALL_URL="${MIRROR}/v${VERSION}/${TARBALL_NAME}"
        CHECKSUM_URL="${MIRROR}/v${VERSION}/${CHECKSUM_NAME}"
    fi

    info "Downloading ${BOLD}${TARBALL_NAME}${NC}..."
    info "URL: $TARBALL_URL"

    # Download tarball
    if [[ "$TARBALL_URL" == file://* ]]; then
        # Local file: copy directly
        local src_path="${TARBALL_URL#file://}"
        if [[ ! -f "$src_path" ]]; then
            die "Tarball not found at local mirror: $src_path"
        fi
        cp "$src_path" "$TARBALL_PATH"
    else
        # Remote file: use curl or wget
        if command -v curl &>/dev/null; then
            curl -fSL --progress-bar -o "$TARBALL_PATH" "$TARBALL_URL" || die "Download failed"
        elif command -v wget &>/dev/null; then
            wget --show-progress -q -O "$TARBALL_PATH" "$TARBALL_URL" || die "Download failed"
        else
            die "curl or wget is required. Please install curl or wget."
        fi
    fi

    local size
    size=$(du -h "$TARBALL_PATH" | cut -f1)
    success "Downloaded tarball ($size)"

    # Download SHA256 checksum
    info "Downloading ${BOLD}${CHECKSUM_NAME}${NC}..."
    if [[ "$CHECKSUM_URL" == file://* ]]; then
        local src_path="${CHECKSUM_URL#file://}"
        if [[ ! -f "$src_path" ]]; then
            die "Checksum file not found at local mirror: $src_path"
        fi
        cp "$src_path" "$CHECKSUM_PATH"
    else
        if command -v curl &>/dev/null; then
            curl -fSL -o "$CHECKSUM_PATH" "$CHECKSUM_URL" || die "Checksum download failed"
        elif command -v wget &>/dev/null; then
            wget -q -O "$CHECKSUM_PATH" "$CHECKSUM_URL" || die "Checksum download failed"
        fi
    fi

    success "Downloaded checksum"
}

verify_checksum() {
    info "Verifying SHA256 checksum..."

    # Read expected checksum (from .sha256 file)
    local expected_checksum
    expected_checksum=$(awk '{print $1}' "$CHECKSUM_PATH")

    if [[ -z "$expected_checksum" ]]; then
        die "Failed to read checksum from $CHECKSUM_NAME"
    fi

    # Calculate actual checksum
    local actual_checksum
    if command -v shasum &>/dev/null; then
        actual_checksum=$(shasum -a 256 "$TARBALL_PATH" | awk '{print $1}')
    elif command -v sha256sum &>/dev/null; then
        actual_checksum=$(sha256sum "$TARBALL_PATH" | awk '{print $1}')
    else
        die "shasum or sha256sum is required to verify the archive"
    fi

    if [[ "$actual_checksum" != "$expected_checksum" ]]; then
        error "Checksum mismatch!"
        error "Expected: $expected_checksum"
        error "Actual:   $actual_checksum"
        die "Tarball may be corrupted. Please try again."
    fi

    success "Checksum verified: ${expected_checksum:0:16}..."
}

extract_tarball() {
    info "Installing to ${BOLD}${INSTALL_DIR}${NC}..."

    # Validate the downloaded payload before changing an existing installation.
    local parent_dir="$(dirname "$INSTALL_DIR")"
    mkdir -p "$parent_dir"
    local lock="${INSTALL_DIR}.install-lock"
    mkdir "$lock" || die "Another install is using $INSTALL_DIR (lock: $lock)"
    INSTALL_LOCK="$lock"
    check_install_paths
    EXTRACT_TEMP="$(mktemp -d "${parent_dir}/.aelix-studio-web.XXXXXXXX")"
    local payload="${EXTRACT_TEMP}/aelix-studio-web"
    tar -xzf "$TARBALL_PATH" -C "$EXTRACT_TEMP" || die "Failed to extract tarball"
    [[ -d "$payload" && ! -L "$payload" && -f "$payload/$EXECUTABLE" && ! -L "$payload/$EXECUTABLE" ]] ||
        die "Tarball structure is invalid (missing aelix-studio-web/$EXECUTABLE)"
    chmod +x "$payload/$EXECUTABLE"

    # Leave a previous Studio version recoverable on upgrade.
    local backup_dir=""
    if [[ -d "$INSTALL_DIR" ]]; then
        backup_dir="${INSTALL_DIR}.backup.$(date +%s)"
        [[ ! -e "$backup_dir" && ! -L "$backup_dir" ]] || die "Backup path already exists: $backup_dir"
        mv "$INSTALL_DIR" "$backup_dir"
    fi
    if ! mv "$payload" "$INSTALL_DIR"; then
        [[ -z "$backup_dir" ]] || mv "$backup_dir" "$INSTALL_DIR"
        die "Failed to move the new installation into place"
    fi

    # On macOS, strip the quarantine xattr Safari/Chrome/curl-downloaded files
    # inherit — otherwise Gatekeeper kills unsigned Mach-O binaries with a
    # "damaged, can't be opened" dialog. This is standard practice for CLI
    # tools distributed as tarballs (bun, deno, rustup do the same).
    if command -v xattr &>/dev/null; then
        xattr -dr com.apple.quarantine "${INSTALL_DIR}" 2>/dev/null || true
    fi

    success "Installation completed"
}

check_install_paths() {
    # A relative override is resolved against the calling shell, not the link directory.
    [[ "$INSTALL_DIR" == /* ]] || INSTALL_DIR="$PWD/$INSTALL_DIR"
    [[ "$BIN_DIR" == /* ]] || BIN_DIR="$PWD/$BIN_DIR"
    while [[ "$INSTALL_DIR" == */ ]]; do INSTALL_DIR="${INSTALL_DIR%/}"; done
    [[ -n "$INSTALL_DIR" && ! -L "$INSTALL_DIR" ]] || die "Invalid installation directory: $INSTALL_DIR"
    if [[ -e "$INSTALL_DIR" ]]; then
        local installed="$INSTALL_DIR/$EXECUTABLE"
        [[ -f "$installed" && -x "$installed" && ! -L "$installed" ]] ||
            die "Installation directory already exists and does not contain Aelix Studio WebUI: $INSTALL_DIR"
    fi

    if [[ "$CREATE_SYMLINK" == 1 ]]; then
        local link="$BIN_DIR/$EXECUTABLE"
        if [[ -L "$link" ]]; then
            [[ "$(readlink "$link")" == "$INSTALL_DIR/$EXECUTABLE" ]] || die "Symlink already points elsewhere: $link"
        elif [[ -e "$link" ]]; then
            die "File already exists at $link"
        fi
    fi
}

create_symlink() {
    local symlink_path="${BIN_DIR}/${EXECUTABLE}"
    local target_path="${INSTALL_DIR}/${EXECUTABLE}"
    mkdir -p "$BIN_DIR"
    if [[ ! -L "$symlink_path" ]]; then
        ln -s "$target_path" "$symlink_path" || die "Failed to create symlink"
    fi
    success "Symlink ready: $symlink_path"
}

update_shell_profile() {
    # Check if BIN_DIR is already in PATH
    if [[ ":$PATH:" == *":${BIN_DIR}:"* ]]; then
        info "PATH already contains ${BOLD}${BIN_DIR}${NC}"
        return
    fi

    info "Adding ${BOLD}${BIN_DIR}${NC} to PATH in shell profile..."

    # Detect current shell
    local shell_name
    shell_name="$(basename "${SHELL:-bash}")"

    local profile_file=""
    case "$shell_name" in
        bash)
            if [[ -f "$HOME/.bashrc" ]]; then
                profile_file="$HOME/.bashrc"
            elif [[ -f "$HOME/.bash_profile" ]]; then
                profile_file="$HOME/.bash_profile"
            fi
            ;;
        zsh)
            profile_file="$HOME/.zshrc"
            ;;
        fish)
            profile_file="$HOME/.config/fish/config.fish"
            ;;
        *)
            warn "Unknown shell: $shell_name. Please manually add ${BIN_DIR} to PATH."
            return
            ;;
    esac

    if [[ -z "$profile_file" ]]; then
        warn "Shell profile not found. Please manually add ${BIN_DIR} to PATH."
        return
    fi

    # Add PATH configuration
    local path_line="export PATH=\"${BIN_DIR}:\$PATH\""

    # Check if configuration already exists
    if grep -Fq -- "${BIN_DIR}" "$profile_file" 2>/dev/null; then
        info "PATH configuration already exists in $profile_file"
        return
    fi

    # Add to profile
    echo "" >> "$profile_file"
    echo "# Added by aelix-studio-web installer" >> "$profile_file"
    echo "$path_line" >> "$profile_file"

    success "Added PATH to $profile_file"
    warn "Please restart your shell or run: source $profile_file"
}

print_summary() {
    echo ""
    echo -e "${GREEN}${BOLD}══════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}${BOLD}  🎉 Aelix Studio WebUI v${VERSION} Installed!${NC}"
    echo -e "${GREEN}${BOLD}══════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${BOLD}📍 Installation directory:${NC}  ${INSTALL_DIR}"
    if [[ "$CREATE_SYMLINK" == "1" ]]; then
        echo -e "  ${BOLD}📍 Symlink:${NC}                ${BIN_DIR}/${EXECUTABLE}"
    fi
    echo ""
    echo -e "  ${BOLD}🚀 Usage:${NC}"
    echo ""
    if [[ "$CREATE_SYMLINK" == "1" && ":$PATH:" == *":${BIN_DIR}:"* ]]; then
        echo "    # Start Aelix Studio WebUI"
        echo "    ${EXECUTABLE} start"
        echo ""
        echo "    # Check version"
        echo "    ${EXECUTABLE} version"
    else
        echo "    # Start Aelix Studio WebUI (using full path)"
        printf "    %q start\n" "${INSTALL_DIR}/${EXECUTABLE}"
        echo ""
        echo "    # Or add symlink to PATH:"
        if [[ "$CREATE_SYMLINK" == "1" ]]; then
            echo "    export PATH=\"${BIN_DIR}:\$PATH\""
        else
            printf '    ln -s %q %q\n' "$INSTALL_DIR/$EXECUTABLE" "$BIN_DIR/$EXECUTABLE"
            echo "    export PATH=\"${BIN_DIR}:\$PATH\""
        fi
    fi
    echo ""
    echo -e "  ${BOLD}📖 Documentation:${NC}  https://github.com/handochan/aelix-studio"
    echo -e "  ${BOLD}🐛 Report issues:${NC}  https://github.com/handochan/aelix-studio/issues"
    echo ""
    echo -e "  ${BOLD}🗑️  Uninstall:${NC}"
    echo ""
    echo "    # Stop the WebUI and disable any configured systemd unit first."
    echo "    # Remove installation directory"
    printf "    rm -rf -- %q\n" "$INSTALL_DIR"
    if [[ "$CREATE_SYMLINK" == "1" ]]; then
        echo ""
        echo "    # Remove symlink"
        printf "    rm -- %q\n" "${BIN_DIR}/${EXECUTABLE}"
    fi
    echo ""
}

cleanup() {
    [[ -z "$TEMP_DIR" ]] || rm -rf -- "$TEMP_DIR"
    [[ -z "$EXTRACT_TEMP" ]] || rm -rf -- "$EXTRACT_TEMP"
    [[ -z "$INSTALL_LOCK" ]] || rmdir -- "$INSTALL_LOCK"
}

# ─── Main Flow ──────────────────────────────────────────────────────────────
main() {
    banner
    parse_args "$@"
    trap cleanup EXIT

    # Step 1: Detect platform and architecture
    detect_platform_arch
    check_install_paths

    # Step 2: Resolve version (if VERSION is __VERSION__ or latest)
    resolve_version

    # Step 3: Download tarball
    download_tarball

    # Step 4: Verify SHA256 checksum
    verify_checksum

    # Step 5: Extract tarball
    extract_tarball

    # Step 6: Create symlink
    if [[ "$CREATE_SYMLINK" == "1" ]]; then
        create_symlink
    fi

    # Step 7: Update shell profile PATH
    if [[ "$UPDATE_PATH" == "1" ]]; then
        update_shell_profile
    fi

    # Step 8: Print summary
    print_summary
}

# Execute
main "$@"
