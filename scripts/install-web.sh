#!/usr/bin/env bash
# ============================================================================
# Aelix Studio WebUI — One-Click Installation Script
# ============================================================================
# Usage:
#   # Set RELEASE_TAG to the published Studio tag, including its v prefix.
#   curl -q --proto '=https' --proto-redir '=https' -fsSL "https://github.com/handochan/aelix-studio/releases/download/${RELEASE_TAG}/install-aelix-studio-web.sh" | bash
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
INSTALL_MARKER=".aelix-studio-web-install"

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
    echo "  ║         Aelix Studio WebUI Installer         ║"
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
  --version <version>       Override the embedded version (use latest for stable releases)
  --mirror <url>            Use an HTTPS or local file:// mirror (default: GitHub releases)
  --install-dir <path>      Specify installation directory (default: ~/.local/share/aelix-studio-web)
  --no-symlink              Do not create symlink in ~/.local/bin
  --no-path                 Do not add PATH to shell profile
  --help                    Show this help message

Stop the running WebUI or its systemd service before upgrading.
curl is required for mirrors that redirect, including GitHub release assets.
Without curl, GNU Wget can fetch an HTTPS mirror that serves files directly.

Environment Variables:
  VERSION                   Version to install (same as --version)
  INSTALL_DIR               Installation directory (same as --install-dir)
  MIRROR                    Mirror URL (same as --mirror)

Examples:
  # Set RELEASE_TAG to the published Studio tag (include its v prefix).
  curl -q --proto '=https' --proto-redir '=https' -fsSL "https://github.com/handochan/aelix-studio/releases/download/\${RELEASE_TAG}/install-aelix-studio-web.sh" | bash

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

fetch_https() {
    local url="$1" output="$2"
    [[ "$url" == https://* ]] || die "Online downloads require HTTPS: $url"
    if command -v curl &>/dev/null; then
        curl -q --proto '=https' --proto-redir '=https' -fsSL -o "$output" -- "$url"
    elif command -v wget &>/dev/null; then
        # GNU Wget's --https-only only applies to recursive downloads.
        wget --no-config --max-redirect=0 -q -O "$output" -- "$url" ||
            die "Direct HTTPS download failed. Use curl for mirrors that redirect."
    else
        die "curl or GNU Wget is required to download over HTTPS"
    fi
}

resolve_version() {
    if [[ "$VERSION" == __*__ ]]; then
        die "This source installer has no embedded version. Pass --version or use the installer from a versioned Studio release."
    fi

    if [[ "$VERSION" == latest ]]; then
        info "Resolving the latest stable release from GitHub..."
        local release_url="https://api.github.com/repos/handochan/aelix-studio/releases/latest"
        local release_json
        local release_error="Could not resolve a stable release. Pass --version with the version from the published Studio tag."
        release_json=$(fetch_https "$release_url" -) || die "$release_error"
        VERSION=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\([^"]*\)".*/\1/p' <<< "$release_json")
        [[ -n "$VERSION" ]] || die "$release_error"
    fi
    info "Using version: ${BOLD}v${VERSION}${NC}"

    if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$ ]]; then
        die "Invalid release version: $VERSION"
    fi

    # Match the packer and the release tag, including Beta prereleases.
    TARBALL_NAME="aelix-studio-web-${VERSION}-${PLATFORM}-${ARCH}.tar.gz"
    CHECKSUM_NAME="${TARBALL_NAME}.sha256"
}

download_asset() {
    local name="$1" destination="$2"
    local url="${MIRROR%/}/v${VERSION}/$name"
    info "Downloading ${BOLD}${name}${NC}..."
    if [[ "$url" == file://* ]]; then
        local source="${url#file://}"
        [[ -f "$source" ]] || die "File not found at local mirror: $source"
        cp -- "$source" "$destination"
    else
        fetch_https "$url" "$destination" || die "HTTPS download failed: $name"
    fi
}

download_tarball() {
    TEMP_DIR="$(mktemp -d)"
    TARBALL_PATH="${TEMP_DIR}/${TARBALL_NAME}"
    CHECKSUM_PATH="${TEMP_DIR}/${CHECKSUM_NAME}"
    download_asset "$TARBALL_NAME" "$TARBALL_PATH"
    download_asset "$CHECKSUM_NAME" "$CHECKSUM_PATH"
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
    [[ -z "$(find "$EXTRACT_TEMP" -mindepth 1 -maxdepth 1 ! -name aelix-studio-web -print)" ]] ||
        die "Tarball contains entries outside the aelix-studio-web directory"
    validate_archive_links "$payload"
    validate_payload "$payload"
    chmod +x "$payload/$EXECUTABLE"
    [[ ! -e "$payload/$INSTALL_MARKER" && ! -L "$payload/$INSTALL_MARKER" ]] ||
        die "Tarball contains the reserved installation marker"
    printf '%s\n' 'aelix-studio-web' > "$payload/$INSTALL_MARKER"

    # Clear macOS quarantine on the verified staging tree without following links.
    if [[ "$PLATFORM" == darwin ]] && command -v xattr &>/dev/null; then
        xattr -d -r -s com.apple.quarantine "$payload" 2>/dev/null || true
    fi

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
    if [[ "$CREATE_SYMLINK" == 1 ]] && ! create_symlink; then
        # The downloaded payload was moved on the same filesystem. Move it
        # back to staging before restoring the previous installation.
        mv "$INSTALL_DIR" "$payload" || die "Could not roll back the installation at $INSTALL_DIR"
        [[ -z "$backup_dir" ]] || mv "$backup_dir" "$INSTALL_DIR"
        die "Failed to create the command link; the new installation was rolled back"
    fi

    success "Installation completed"
    if [[ "$CREATE_SYMLINK" == 1 ]]; then success "Symlink ready: $BIN_DIR/$EXECUTABLE"; fi
}

validate_archive_links() {
    local root link target resolved
    root=$(realpath "$1") || die "Cannot resolve the extracted package"
    find "$root" -type l -print0 > "$TEMP_DIR/archive-links" || die "Could not inspect tarball links"
    while IFS= read -r -d '' link; do
        target=$(readlink "$link") || die "Could not read tarball link: ${link#"$root/"}"
        [[ "$target" != /* ]] || die "Tarball contains an absolute link: ${link#"$root/"}"
        resolved=$(realpath "$link" 2>/dev/null) || die "Tarball contains a dangling or invalid link: ${link#"$root/"}"
        [[ -e "$resolved" && "$resolved" == "$root/"* ]] ||
            die "Tarball link escapes its installation tree or is dangling: ${link#"$root/"}"
    done < "$TEMP_DIR/archive-links"
}

validate_payload() {
    local payload="$1"
    local host_platform="$PLATFORM"
    local host_arch="$ARCH"
    local host="aelix-studio-host"
    if [[ "$PLATFORM" == win ]]; then
        host_platform="win32"
        host="${host}.exe"
    fi
    if [[ "$ARCH" == x86_64 ]]; then host_arch="x64"; fi
    local host_path="$payload/bundled-aioncore/${host_platform}-${host_arch}/$host"
    [[ -f "$host_path" && -x "$host_path" ]] || die "Tarball structure is invalid (missing executable Studio host)"
    local required_files=(package.json static/index.html)
    if [[ "$PLATFORM" == linux ]]; then required_files+=(aelix-studio-web.service); fi
    local file
    for file in "${required_files[@]}"; do
        [[ -f "$payload/$file" && -s "$payload/$file" ]] || die "Tarball structure is invalid (missing $file)"
    done
}

canonical_path() {
    local candidate="$1" parent leaf
    if [[ -e "$candidate" || -L "$candidate" ]]; then
        realpath "$candidate"
        return
    fi
    parent=$(canonical_path "$(dirname "$candidate")") || return 1
    leaf=$(basename "$candidate")
    case "$leaf" in
        .) printf '%s\n' "$parent" ;;
        ..) dirname "$parent" ;;
        *) printf '%s/%s\n' "${parent%/}" "$leaf" ;;
    esac
}

normalize_install_paths() {
    [[ "$INSTALL_DIR" == /* ]] || INSTALL_DIR="$PWD/$INSTALL_DIR"
    [[ "$BIN_DIR" == /* ]] || BIN_DIR="$PWD/$BIN_DIR"
    while [[ "$INSTALL_DIR" != / ]]; do
        case "$INSTALL_DIR" in
            */) INSTALL_DIR="${INSTALL_DIR%/}" ;;
            */.) INSTALL_DIR="${INSTALL_DIR%/.}" ;;
            *) break ;;
        esac
    done
    [[ -n "$INSTALL_DIR" && ! -L "$INSTALL_DIR" ]] || die "Invalid installation directory: $INSTALL_DIR"
    INSTALL_DIR=$(canonical_path "$INSTALL_DIR") || die "Could not resolve the installation directory"
    [[ "$INSTALL_DIR" != / ]] || die "The filesystem root cannot be an installation directory"
    BIN_DIR=$(canonical_path "$BIN_DIR") || die "Could not resolve the command directory"
}

link_points_to_install() {
    local link="$1" target="$INSTALL_DIR/$EXECUTABLE" resolved
    if [[ "$(readlink "$link")" == "$target" ]]; then return 0; fi
    resolved=$(realpath "$link" 2>/dev/null) || return 1
    [[ "$resolved" == "$target" ]]
}

check_install_paths() {
    [[ ! -L "$INSTALL_DIR" ]] || die "Invalid installation directory: $INSTALL_DIR"
    if [[ -e "$INSTALL_DIR" ]]; then
        local upstream
        for upstream in aionui-web aionui-web.exe; do
            if [[ -e "$INSTALL_DIR/$upstream" || -L "$INSTALL_DIR/$upstream" ]]; then
                die "Installation directory contains AionUi WebUI: $INSTALL_DIR"
            fi
        done
        local installed="$INSTALL_DIR/$EXECUTABLE" marker="$INSTALL_DIR/$INSTALL_MARKER"
        [[ -f "$installed" && -x "$installed" && ! -L "$installed" ]] ||
            die "Installation directory already exists and does not contain Aelix Studio WebUI: $INSTALL_DIR"
        if [[ ! -f "$marker" || -L "$marker" || "$(< "$marker")" != aelix-studio-web ]]; then
            # Earlier Studio installations have no marker. Require the Studio-specific layout.
            validate_payload "$INSTALL_DIR"
        fi
    fi

    if [[ "$CREATE_SYMLINK" == 1 ]]; then
        [[ "$BIN_DIR" != "$INSTALL_DIR" ]] || die "Command link directory must differ from the installation root"
        local link="$BIN_DIR/$EXECUTABLE"
        if [[ -L "$link" ]]; then
            link_points_to_install "$link" || die "Symlink already points elsewhere: $link"
        elif [[ -e "$link" ]]; then
            die "File already exists at $link"
        fi
    fi
}

create_symlink() {
    local symlink_path="${BIN_DIR}/${EXECUTABLE}"
    local target_path="${INSTALL_DIR}/${EXECUTABLE}"
    mkdir -p "$BIN_DIR" || return 1
    if [[ -e "$symlink_path" && ! -L "$symlink_path" ]]; then
        error "File already exists at $symlink_path"
        return 1
    fi
    if [[ ! -L "$symlink_path" ]]; then
        ln -sn "$target_path" "$symlink_path" || return 1
    fi
    if ! link_points_to_install "$symlink_path"; then
        error "Command path does not point to the Studio executable: $symlink_path"
        return 1
    fi
}

path_command() {
    if [[ "$1" == fish ]]; then
        local fish_bin_dir="${BIN_DIR//\\/\\\\}"
        fish_bin_dir="${fish_bin_dir//\'/\\\'}"
        printf "set -gx PATH '%s' \$PATH\n" "$fish_bin_dir"
    else
        printf 'export PATH=%q:"$PATH"\n' "$BIN_DIR"
    fi
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

    local path_line
    path_line=$(path_command "$shell_name")

    # Check if configuration already exists
    if grep -Fxq -- "$path_line" "$profile_file" 2>/dev/null; then
        info "PATH configuration already exists in $profile_file"
        return
    fi

    # Add to profile
    printf '\n# Added by aelix-studio-web installer\n%s\n' "$path_line" >> "$profile_file"

    success "Added PATH to $profile_file"
    warn "Restart your shell to load the updated PATH."
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
        if [[ "$CREATE_SYMLINK" != "1" ]]; then
            printf '    ln -s %q %q\n' "$INSTALL_DIR/$EXECUTABLE" "$BIN_DIR/$EXECUTABLE"
        fi
        printf '    %s\n' "$(path_command "$(basename "${SHELL:-bash}")")"
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
    case "$MIRROR" in
        https://*|file://*) ;;
        *) die "Mirrors must use HTTPS or a local file:// path" ;;
    esac
    command -v realpath &>/dev/null || die "realpath is required to validate installation paths"
    normalize_install_paths
    check_install_paths

    # Step 2: Resolve version (if VERSION is __VERSION__ or latest)
    resolve_version

    # Step 3: Download tarball
    download_tarball

    # Step 4: Verify SHA256 checksum
    verify_checksum

    # Step 5: Install the validated tarball and command link
    extract_tarball

    # Step 6: Update shell profile PATH
    if [[ "$UPDATE_PATH" == "1" ]]; then
        update_shell_profile
    fi

    # Step 7: Print summary
    print_summary
}

# Execute
main "$@"
