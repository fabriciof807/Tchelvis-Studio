#!/usr/bin/env bash
set -euo pipefail

REPO="${GAME_HUB_REPO:-fabriciof807/Tchelvis-Studio}"
CHANNEL="${GAME_HUB_CHANNEL:-stable}"
FORMAT="${GAME_HUB_FORMAT:-auto}"
FROM_SOURCE=0
INSTALL_DIR="${GAME_HUB_DIR:-$HOME/.local/share/game-hub}"
BIN_DIR="${GAME_HUB_BIN_DIR:-$HOME/.local/bin}"
CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/game-hub"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
TARBALL_ASSET="game-hub-linux-x86_64.tar.gz"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --channel)
            CHANNEL="${2:-stable}"
            shift 2
            ;;
        --channel=*)
            CHANNEL="${1#*=}"
            shift
            ;;
        --format)
            FORMAT="${2:-auto}"
            shift 2
            ;;
        --format=*)
            FORMAT="${1#*=}"
            shift
            ;;
        --from-source)
            FROM_SOURCE=1
            shift
            ;;
        *)
            shift
            ;;
    esac
done

case "$CHANNEL" in
    nightly|NIGHTLY) CHANNEL="nightly" ;;
    *) CHANNEL="stable" ;;
esac

info()  { printf '\033[1;34m[tchelvis-studio]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[tchelvis-studio]\033[0m %s\n' "$*"; }
error() { printf '\033[1;31m[tchelvis-studio]\033[0m %s\n' "$*" >&2; exit 1; }

need_cmd() {
    command -v "$1" >/dev/null 2>&1
}

detect_pkg_manager() {
    if need_cmd pacman; then
        echo "pacman"
    elif need_cmd apt-get; then
        echo "apt"
    elif need_cmd dnf; then
        echo "dnf"
    elif need_cmd zypper; then
        echo "zypper"
    else
        echo "unknown"
    fi
}

install_linux_deps() {
    local pm
    pm=$(detect_pkg_manager)

    case "$pm" in
        pacman)
            local pkgs=(git curl webkit2gtk-4.1 gtk3 dbus libayatana-appindicator librsvg xdotool)
            if [ "$FROM_SOURCE" -eq 1 ]; then
                pkgs+=(base-devel nodejs npm)
                if ! need_cmd cargo; then pkgs+=(rust); fi
            fi
            local missing=()
            for pkg in "${pkgs[@]}"; do
                if ! pacman -Qi "$pkg" >/dev/null 2>&1; then
                    missing+=("$pkg")
                fi
            done
            if [ "${#missing[@]}" -gt 0 ]; then
                info "Instalando dependências via pacman: ${missing[*]}"
                sudo pacman -S --needed --noconfirm "${missing[@]}"
            else
                info "Todas as dependências necessárias já estão instaladas."
            fi
            ;;
        apt)
            local pkgs=(git curl libwebkit2gtk-4.1-0 libgtk-3-0 libdbus-1-3 libayatana-appindicator3-1 librsvg2-2 xdotool)
            if [ "$FROM_SOURCE" -eq 1 ]; then
                pkgs+=(build-essential pkg-config patchelf libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev libdbus-1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev nodejs npm)
            fi
            info "Instalando dependências via apt-get..."
            sudo apt-get update
            sudo apt-get install -y "${pkgs[@]}"
            ;;
        dnf)
            local pkgs=(git curl webkit2gtk4.1 gtk3 dbus-libs libayatana-appindicator-gtk3 librsvg2 xdotool)
            if [ "$FROM_SOURCE" -eq 1 ]; then
                pkgs+=(pkgconf-pkg-config openssl-devel webkit2gtk4.1-devel gtk3-devel dbus-devel libayatana-appindicator-gtk3-devel librsvg2-devel libxdo-devel nodejs npm)
                info "Instalando dependências de desenvolvimento via dnf..."
                sudo dnf groupinstall -y "Development Tools" || true
            else
                info "Instalando dependências de runtime via dnf..."
            fi
            sudo dnf install -y "${pkgs[@]}"
            ;;
        zypper)
            local pkgs=(git curl libwebkit2gtk-4_1-0 gtk3 libdbus-1-3 libayatana-appindicator3-1 librsvg-2-2 xdotool)
            if [ "$FROM_SOURCE" -eq 1 ]; then
                pkgs+=(pkg-config libopenssl-devel webkit2gtk3-devel gtk3-devel dbus-1-devel libayatana-appindicator3-devel librsvg-devel xdotool-devel nodejs npm)
            fi
            info "Instalando dependências via zypper..."
            sudo zypper --non-interactive install "${pkgs[@]}"
            ;;
        *)
            warn "Gerenciador de pacotes não reconhecido; assumindo que WebKitGTK 4.1, GTK 3, git e curl já estão instalados."
            ;;
    esac

    if [ "$FROM_SOURCE" -eq 1 ] && ! need_cmd cargo; then
        info "Instalando toolchain Rust via rustup..."
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
        # shellcheck source=/dev/null
        [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
    fi
}

install_defaults_dir() {
    local src_dir="$1"
    if [ ! -d "$src_dir" ]; then
        return
    fi
    mkdir -p "$CFG_DIR"
    (
        cd "$src_dir"
        find . -type d -exec mkdir -p "$CFG_DIR/{}" \;
        find . -type f | while IFS= read -r f; do
            if [ ! -e "$CFG_DIR/$f" ]; then
                cp "$f" "$CFG_DIR/$f"
            fi
        done
    )
}

write_desktop_entry() {
    mkdir -p "$DESKTOP_DIR"
    cat > "$DESKTOP_DIR/game-hub.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Tchelvis Studio
GenericName=Game Dev Hub
Comment=Local-first Game Design & Agent Orchestration Studio
Exec=${BIN_DIR}/game-hub
Terminal=false
Categories=Development;IDE;
EOF
}

write_install_state() {
    local tag="$1"
    local commit="$2"
    mkdir -p "$CFG_DIR"
    if [ -n "$tag" ]; then
        cat > "$CFG_DIR/install-state.json" <<EOF
{
  "channel": "${CHANNEL}",
  "tag": "${tag}",
  "commit": "${commit}"
}
EOF
    else
        cat > "$CFG_DIR/install-state.json" <<EOF
{
  "channel": "${CHANNEL}",
  "tag": null,
  "commit": "${commit}"
}
EOF
    fi
}

fetch_release_info() {
    local api_json=""
    if need_cmd curl; then
        api_json=$(curl -fsSL -H "Accept: application/vnd.github+json" \
            "https://api.github.com/repos/${REPO}/releases?per_page=15" || true)
    fi
    if [ -z "$api_json" ] && need_cmd gh && gh auth status >/dev/null 2>&1; then
        gh release list --repo "$REPO" --limit 15 --json tagName,isPrerelease,isDraft
        return
    fi
    printf '%s' "$api_json"
}

try_install_prebuilt_release() {
    if [ "$FROM_SOURCE" -eq 1 ]; then
        return 1
    fi

    local target_pattern="$TARBALL_ASSET"
    case "$FORMAT" in
        deb) target_pattern='\.deb$' ;;
        rpm) target_pattern='\.rpm$' ;;
        appimage) target_pattern='\.AppImage$' ;;
        *) target_pattern="^${TARBALL_ASSET}$" ;;
    esac

    local tag=""
    local asset_name=""
    local asset_url=""

    if need_cmd curl && need_cmd python3; then
        local api_json
        api_json=$(curl -fsSL -H "Accept: application/vnd.github+json" \
            "https://api.github.com/repos/${REPO}/releases?per_page=15" || true)
        if [ -n "$api_json" ]; then
            local parsed
            parsed=$(printf '%s' "$api_json" | python3 -c '
import json, re, sys
channel, pattern = sys.argv[1], sys.argv[2]
releases = json.load(sys.stdin)
for r in releases:
    if r.get("draft"): continue
    is_nightly = (r.get("tag_name") == "nightly" or bool(r.get("prerelease")))
    if channel == "nightly" and not is_nightly: continue
    if channel != "nightly" and is_nightly: continue
    for a in r.get("assets", []):
        if re.search(pattern, a.get("name", "")):
            print(r["tag_name"])
            print(a["name"])
            print(a["browser_download_url"])
            sys.exit(0)
' "$CHANNEL" "$target_pattern" 2>/dev/null || true)
            if [ -n "$parsed" ]; then
                tag=$(printf '%s\n' "$parsed" | sed -n '1p')
                asset_name=$(printf '%s\n' "$parsed" | sed -n '2p')
                asset_url=$(printf '%s\n' "$parsed" | sed -n '3p')
            fi
        fi
    fi

    if [ -z "$tag" ] && need_cmd gh && gh auth status >/dev/null 2>&1; then
        if [ "$CHANNEL" = "nightly" ]; then
            tag=$(gh release list --repo "$REPO" --limit 15 --json tagName,isPrerelease,isDraft \
                --jq '.[] | select(.isDraft == false and (.tagName == "nightly" or .isPrerelease == true)) | .tagName' \
                | head -n 1 || true)
        else
            tag=$(gh release list --repo "$REPO" --limit 15 --json tagName,isPrerelease,isDraft \
                --jq '.[] | select(.isDraft == false and .isPrerelease == false) | .tagName' \
                | head -n 1 || true)
        fi
        if [ -n "$tag" ]; then
            asset_name=$(gh release view "$tag" --repo "$REPO" --json assets \
                --jq ".assets[] | select(.name | test(\"${target_pattern}\")) | .name" | head -n 1 || true)
        fi
    fi

    if [ -z "$tag" ] || [ -z "$asset_name" ]; then
        return 1
    fi

    info "Baixando release pré-compilada do CI/CD (${CHANNEL}: ${tag} · ${asset_name})..."
    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap 'rm -rf "$tmp_dir"' RETURN

    if [ -n "$asset_url" ] && curl -fsSL -L "$asset_url" -o "$tmp_dir/$asset_name"; then
        :
    elif ! curl -fsSL -L "https://github.com/${REPO}/releases/download/${tag}/${asset_name}" -o "$tmp_dir/$asset_name"; then
        if need_cmd gh && gh auth status >/dev/null 2>&1; then
            gh release download "$tag" --repo "$REPO" -p "$asset_name" -D "$tmp_dir"
        else
            return 1
        fi
    fi

    if curl -fsSL -L "https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS.txt" -o "$tmp_dir/SHA256SUMS.txt" 2>/dev/null \
        || (need_cmd gh && gh release download "$tag" --repo "$REPO" -p SHA256SUMS.txt -D "$tmp_dir" >/dev/null 2>&1); then
        (cd "$tmp_dir" && grep -F "  ${asset_name}" SHA256SUMS.txt > check.sha256 && sha256sum -c check.sha256) || true
    fi

    local commit=""
    if curl -fsSL -L "https://github.com/${REPO}/releases/download/${tag}/manifest.json" -o "$tmp_dir/manifest.json" 2>/dev/null \
        || (need_cmd gh && gh release download "$tag" --repo "$REPO" -p manifest.json -D "$tmp_dir" >/dev/null 2>&1); then
        commit=$(sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp_dir/manifest.json" | head -n 1 || true)
    fi
    if [ -z "$commit" ]; then
        commit="$tag"
    fi

    case "$FORMAT" in
        deb)
            info "Instalando pacote .deb..."
            sudo apt-get install -y "$tmp_dir/$asset_name" || { sudo dpkg -i "$tmp_dir/$asset_name" && sudo apt-get install -f -y; }
            write_install_state "$tag" "$commit"
            return 0
            ;;
        rpm)
            info "Instalando pacote .rpm..."
            if need_cmd dnf; then
                sudo dnf install -y "$tmp_dir/$asset_name"
            elif need_cmd zypper; then
                sudo zypper --non-interactive install --allow-unsigned-rpm "$tmp_dir/$asset_name"
            else
                sudo rpm -Uvh --replacepkgs "$tmp_dir/$asset_name"
            fi
            write_install_state "$tag" "$commit"
            return 0
            ;;
        appimage)
            mkdir -p "$BIN_DIR"
            install -Dm755 "$tmp_dir/$asset_name" "$BIN_DIR/game-hub.AppImage"
            ln -sf "$BIN_DIR/game-hub.AppImage" "$BIN_DIR/game-hub"
            write_desktop_entry
            write_install_state "$tag" "$commit"
            info "AppImage instalado em $BIN_DIR/game-hub.AppImage (link: $BIN_DIR/game-hub)"
            return 0
            ;;
        *)
            mkdir -p "$tmp_dir/extracted"
            tar -xzf "$tmp_dir/$asset_name" -C "$tmp_dir/extracted"
            mkdir -p "$BIN_DIR"
            install -Dm755 "$tmp_dir/extracted/game-hub" "$BIN_DIR/game-hub"
            install_defaults_dir "$tmp_dir/extracted/defaults"
            write_desktop_entry
            write_install_state "$tag" "$commit"
            info "Instalado via CI/CD (${CHANNEL} · ${tag}) em $BIN_DIR/game-hub"
            return 0
            ;;
    esac
}

resolve_target_branch() {
    local dir="$1"
    if [ "$CHANNEL" = "nightly" ]; then
        if git -C "$dir" ls-remote --exit-code --heads origin nightly >/dev/null 2>&1; then
            echo "nightly"
            return
        fi
    else
        if git -C "$dir" ls-remote --exit-code --heads origin stable >/dev/null 2>&1; then
            echo "stable"
            return
        fi
    fi
    echo "master"
}

clone_or_update_repo() {
    mkdir -p "$(dirname "$INSTALL_DIR")"

    if [ ! -d "$INSTALL_DIR/.git" ]; then
        info "Clonando $REPO em $INSTALL_DIR..."
        git clone "https://github.com/${REPO}.git" "$INSTALL_DIR"
    else
        local current_origin
        current_origin=$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)
        if printf '%s' "$current_origin" | grep -q "fabriciof807/game-hub"; then
            git -C "$INSTALL_DIR" remote set-url origin "https://github.com/${REPO}.git"
        fi
    fi

    local target_branch
    target_branch=$(resolve_target_branch "$INSTALL_DIR")
    info "Sincronizando canal '${CHANNEL}' (branch ${target_branch}) em $INSTALL_DIR..."
    git -C "$INSTALL_DIR" fetch origin "$target_branch"
    git -C "$INSTALL_DIR" checkout -B "$target_branch" "origin/${target_branch}"
}

build_and_install_from_source() {
    cd "$INSTALL_DIR"

    info "Instalando dependências do frontend e gerando build..."
    npm ci --no-audit --no-fund
    npm run build

    info "Compilando binário Tauri (--features desktop,custom-protocol --release)..."
    GAME_HUB_CHANNEL="$CHANNEL" cargo build --manifest-path src-tauri/Cargo.toml --release --features desktop,custom-protocol

    mkdir -p "$BIN_DIR"
    install -Dm755 "src-tauri/target/release/game-hub" "$BIN_DIR/game-hub"
    install_defaults_dir "$INSTALL_DIR/defaults"
    write_desktop_entry

    local commit
    commit=$(git -C "$INSTALL_DIR" rev-parse --short HEAD)
    write_install_state "" "$commit"

    info "Instalado em $BIN_DIR/game-hub"
    info "Atalho criado em $DESKTOP_DIR/game-hub.desktop"
}

main() {
    install_linux_deps

    if try_install_prebuilt_release; then
        case ":${PATH}:" in
            *":${BIN_DIR}:"*) ;;
            *) warn "$BIN_DIR não está no seu PATH. Adicione: export PATH=\"$BIN_DIR:\$PATH\"" ;;
        esac
        info "Pronto! Execute 'game-hub' para abrir."
        return
    fi

    FROM_SOURCE=1
    install_linux_deps
    clone_or_update_repo
    build_and_install_from_source

    case ":${PATH}:" in
        *":${BIN_DIR}:"*) ;;
        *) warn "$BIN_DIR não está no seu PATH. Adicione: export PATH=\"$BIN_DIR:\$PATH\"" ;;
    esac
    info "Pronto! Execute 'game-hub' para abrir."
}

main "$@"
