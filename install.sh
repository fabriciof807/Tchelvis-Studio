#!/usr/bin/env bash
set -euo pipefail

REPO="${GAME_HUB_REPO:-fabriciof807/game-hub}"
INSTALL_DIR="${GAME_HUB_DIR:-$HOME/.local/share/game-hub}"
BIN_DIR="${GAME_HUB_BIN_DIR:-$HOME/.local/bin}"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

info()  { printf '\033[1;34m[game-hub]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[game-hub]\033[0m %s\n' "$*"; }
error() { printf '\033[1;31m[game-hub]\033[0m %s\n' "$*" >&2; exit 1; }

need_cmd() {
    command -v "$1" >/dev/null 2>&1
}

install_arch_deps() {
    local pkgs=(
        base-devel
        git
        curl
        webkit2gtk-4.1
        gtk3
        dbus
        libayatana-appindicator
        librsvg
        xdotool
        nodejs
        npm
    )

    if ! need_cmd cargo; then
        pkgs+=(rust)
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
        info "Todas as dependências de sistema já estão instaladas."
    fi
}

clone_or_update_repo() {
    mkdir -p "$(dirname "$INSTALL_DIR")"

    if [ -d "$INSTALL_DIR/.git" ]; then
        info "Atualizando repositório em $INSTALL_DIR..."
        git -C "$INSTALL_DIR" pull --ff-only
        return
    fi

    info "Clonando $REPO em $INSTALL_DIR..."
    if need_cmd gh && gh auth status >/dev/null 2>&1; then
        gh repo clone "$REPO" "$INSTALL_DIR"
    elif [ -n "${GITHUB_TOKEN:-}" ]; then
        git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git" "$INSTALL_DIR"
    else
        git clone "git@github.com:${REPO}.git" "$INSTALL_DIR"
    fi
}

build_and_install() {
    cd "$INSTALL_DIR"

    info "Instalando dependências do frontend e gerando build..."
    npm ci --no-audit --no-fund
    npm run build

    info "Compilando binário Tauri (--features desktop --release)..."
    cargo build --manifest-path src-tauri/Cargo.toml --release --features desktop

    mkdir -p "$BIN_DIR" "$DESKTOP_DIR"
    install -Dm755 "src-tauri/target/release/game-hub" "$BIN_DIR/game-hub"

    cat > "$DESKTOP_DIR/game-hub.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Game Dev Hub
Comment=Local-first Game Design & Agent Orchestration Studio
Exec=${BIN_DIR}/game-hub
Terminal=false
Categories=Development;IDE;
EOF

    info "Instalado em $BIN_DIR/game-hub"
    info "Atalho criado em $DESKTOP_DIR/game-hub.desktop"

    case ":${PATH}:" in
        *":${BIN_DIR}:"*) ;;
        *) warn "$BIN_DIR não está no seu PATH. Adicione: export PATH=\"$BIN_DIR:\$PATH\"" ;;
    esac
}

main() {
    if need_cmd pacman; then
        install_arch_deps
    else
        warn "pacman não encontrado; assumindo que as dependências do Tauri 2, Node.js e Rust já estão instaladas."
    fi

    clone_or_update_repo
    build_and_install
    info "Pronto! Execute 'game-hub' para abrir."
}

main "$@"
