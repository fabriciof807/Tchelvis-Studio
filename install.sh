#!/usr/bin/env bash
set -euo pipefail

REPO="${GAME_HUB_REPO:-fabriciof807/game-hub}"
CHANNEL="${GAME_HUB_CHANNEL:-stable}"
FROM_SOURCE=0
INSTALL_DIR="${GAME_HUB_DIR:-$HOME/.local/share/game-hub}"
BIN_DIR="${GAME_HUB_BIN_DIR:-$HOME/.local/bin}"
CFG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/game-hub"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ASSET_NAME="game-hub-linux-x86_64.tar.gz"

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

info()  { printf '\033[1;34m[game-hub]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[game-hub]\033[0m %s\n' "$*"; }
error() { printf '\033[1;31m[game-hub]\033[0m %s\n' "$*" >&2; exit 1; }

need_cmd() {
    command -v "$1" >/dev/null 2>&1
}

install_arch_runtime_deps() {
    local pkgs=(
        git
        curl
        webkit2gtk-4.1
        gtk3
        dbus
        libayatana-appindicator
        librsvg
        xdotool
    )

    if [ "$FROM_SOURCE" -eq 1 ]; then
        pkgs+=(base-devel nodejs npm)
        if ! need_cmd cargo; then
            pkgs+=(rust)
        fi
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
Name=Game Dev Hub
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

try_install_prebuilt_release() {
    if [ "$FROM_SOURCE" -eq 1 ]; then
        return 1
    fi
    if ! need_cmd gh || ! gh auth status >/dev/null 2>&1; then
        return 1
    fi

    local tag=""
    if [ "$CHANNEL" = "nightly" ]; then
        tag=$(gh release list --repo "$REPO" --limit 15 --json tagName,isPrerelease,isDraft \
            --jq '.[] | select(.isDraft == false and (.tagName == "nightly" or .isPrerelease == true)) | .tagName' \
            | head -n 1 || true)
    else
        tag=$(gh release list --repo "$REPO" --limit 15 --json tagName,isPrerelease,isDraft \
            --jq '.[] | select(.isDraft == false and .isPrerelease == false) | .tagName' \
            | head -n 1 || true)
    fi

    if [ -z "$tag" ]; then
        return 1
    fi

    local has_asset
    has_asset=$(gh release view "$tag" --repo "$REPO" --json assets \
        --jq ".assets[] | select(.name == \"${ASSET_NAME}\") | .name" | head -n 1 || true)
    if [ -z "$has_asset" ]; then
        return 1
    fi

    info "Baixando release pré-compilada do CI/CD (${CHANNEL}: ${tag})..."
    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap 'rm -rf "$tmp_dir"' RETURN

    gh release download "$tag" --repo "$REPO" -p "$ASSET_NAME" -D "$tmp_dir"
    if gh release download "$tag" --repo "$REPO" -p SHA256SUMS.txt -D "$tmp_dir" >/dev/null 2>&1; then
        (cd "$tmp_dir" && sha256sum -c SHA256SUMS.txt)
    fi

    local commit=""
    if gh release download "$tag" --repo "$REPO" -p manifest.json -D "$tmp_dir" >/dev/null 2>&1; then
        commit=$(sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp_dir/manifest.json" | head -n 1 || true)
    fi
    if [ -z "$commit" ]; then
        commit="$tag"
    fi

    mkdir -p "$tmp_dir/extracted"
    tar -xzf "$tmp_dir/$ASSET_NAME" -C "$tmp_dir/extracted"

    mkdir -p "$BIN_DIR"
    install -Dm755 "$tmp_dir/extracted/game-hub" "$BIN_DIR/game-hub"
    install_defaults_dir "$tmp_dir/extracted/defaults"
    write_desktop_entry
    write_install_state "$tag" "$commit"

    info "Instalado via CI/CD (${CHANNEL} · ${tag}) em $BIN_DIR/game-hub"
    return 0
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
        if need_cmd gh && gh auth status >/dev/null 2>&1; then
            gh repo clone "$REPO" "$INSTALL_DIR"
        elif [ -n "${GITHUB_TOKEN:-}" ]; then
            git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git" "$INSTALL_DIR"
        else
            git clone "git@github.com:${REPO}.git" "$INSTALL_DIR"
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
    if need_cmd pacman; then
        install_arch_runtime_deps
    else
        warn "pacman não encontrado; assumindo que as dependências do sistema já estão instaladas."
    fi

    if try_install_prebuilt_release; then
        case ":${PATH}:" in
            *":${BIN_DIR}:"*) ;;
            *) warn "$BIN_DIR não está no seu PATH. Adicione: export PATH=\"$BIN_DIR:\$PATH\"" ;;
        esac
        info "Pronto! Execute 'game-hub' para abrir."
        return
    fi

    FROM_SOURCE=1
    if need_cmd pacman; then
        install_arch_runtime_deps
    fi
    clone_or_update_repo
    build_and_install_from_source

    case ":${PATH}:" in
        *":${BIN_DIR}:"*) ;;
        *) warn "$BIN_DIR não está no seu PATH. Adicione: export PATH=\"$BIN_DIR:\$PATH\"" ;;
    esac
    info "Pronto! Execute 'game-hub' para abrir."
}

main "$@"
