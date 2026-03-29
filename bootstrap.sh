#!/usr/bin/env bash
# Pluribus Swarm Bootstrap
# Installs all dependencies and sets up the swarm on any platform.
# Usage: curl -fsSL https://raw.githubusercontent.com/elevate-foundry/pluribus/master/bootstrap.sh | bash

set -euo pipefail

REPO="https://github.com/elevate-foundry/pluribus.git"
INSTALL_DIR="$HOME/.pluribus-runtime"
BIN_DIR="$HOME/.local/bin"

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo "  ██████╗ ██╗     ██╗   ██╗██████╗ ██╗██████╗ ██╗   ██╗███████╗"
echo "  ██╔══██╗██║     ██║   ██║██╔══██╗██║██╔══██╗██║   ██║██╔════╝"
echo "  ██████╔╝██║     ██║   ██║██████╔╝██║██████╔╝██║   ██║███████╗"
echo "  ██╔═══╝ ██║     ██║   ██║██╔══██╗██║██╔══██╗██║   ██║╚════██║"
echo "  ██║     ███████╗╚██████╔╝██║  ██║██║██████╔╝╚██████╔╝███████║"
echo "  ╚═╝     ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝ ╚══════╝"
echo ""
echo "  Distributed AI swarm with braided inference"
echo "  https://github.com/elevate-foundry/pluribus"
echo ""

# ── Detect OS / environment ───────────────────────────────────────────────────
IS_TERMUX=false
IS_MACOS=false
IS_ARCH=false
IS_FEDORA=false
IS_OPENSUSE=false
PKG_MGR=""

if [ -n "${TERMUX_VERSION:-}" ] || [ -d "/data/data/com.termux" ]; then
  IS_TERMUX=true
  PKG_MGR="termux"
elif [ "$(uname -s)" = "Darwin" ]; then
  IS_MACOS=true
  PKG_MGR="brew"
elif [ -f /etc/os-release ]; then
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian|raspbian|linuxmint|pop)  PKG_MGR="apt" ;;
    fedora)                                 PKG_MGR="dnf"; IS_FEDORA=true ;;
    rhel|centos|rocky|almalinux|ol)        PKG_MGR="dnf_rhel" ;;
    arch|manjaro|endeavouros|garuda)       PKG_MGR="pacman"; IS_ARCH=true ;;
    opensuse*|sles)                        PKG_MGR="zypper"; IS_OPENSUSE=true ;;
    *)                                     PKG_MGR="apt" ;;  # best guess
  esac
else
  PKG_MGR="apt"
fi

echo "==> Detected environment: ${PKG_MGR}"

# ── Step 1: System dependencies ───────────────────────────────────────────────
echo ""
echo "[1/5] Installing system dependencies..."

install_pkg() {
  case "$PKG_MGR" in
    termux)   pkg install -y "$@" ;;
    apt)      sudo apt-get install -y "$@" ;;
    brew)     brew install "$@" ;;
    dnf|dnf_rhel) sudo dnf install -y "$@" ;;
    pacman)   sudo pacman -S --noconfirm "$@" ;;
    zypper)   sudo zypper install -y "$@" ;;
  esac
}

# Core tools
if $IS_TERMUX; then
  pkg update -y
  pkg install -y git curl nodejs cmake make clang binutils
elif $IS_MACOS; then
  if ! command -v brew &>/dev/null; then
    echo "  Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
  brew install git curl node cmake
elif [ "$PKG_MGR" = "apt" ]; then
  sudo apt-get update -qq
  sudo apt-get install -y git curl build-essential cmake
elif [ "$PKG_MGR" = "dnf" ] || [ "$PKG_MGR" = "dnf_rhel" ]; then
  sudo dnf install -y git curl gcc gcc-c++ make cmake
elif $IS_ARCH; then
  sudo pacman -S --noconfirm git curl base-devel cmake
elif $IS_OPENSUSE; then
  sudo zypper install -y git curl gcc gcc-c++ make cmake
fi

echo "  ✓ System dependencies installed"

# ── Step 2: Node.js ───────────────────────────────────────────────────────────
echo ""
echo "[2/5] Setting up Node.js..."

if $IS_TERMUX; then
  # Already installed above
  echo "  ✓ Node.js $(node --version) (Termux)"
elif $IS_MACOS; then
  echo "  ✓ Node.js $(node --version) (Homebrew)"
elif ! command -v node &>/dev/null || [ "$(node -e 'process.exit(parseInt(process.version.slice(1)) < 18 ? 1 : 0)' 2>/dev/null; echo $?)" = "1" ]; then
  echo "  Installing Node.js 22 via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - 2>/dev/null || true
  if [ "$PKG_MGR" = "apt" ]; then
    sudo apt-get install -y nodejs
  elif [ "$PKG_MGR" = "dnf" ] || [ "$PKG_MGR" = "dnf_rhel" ]; then
    sudo dnf install -y nodejs
  fi
  echo "  ✓ Node.js $(node --version)"
else
  echo "  ✓ Node.js $(node --version) (already installed)"
fi

# pnpm
if ! command -v pnpm &>/dev/null; then
  echo "  Installing pnpm..."
  npm install -g pnpm 2>&1 | tail -1
fi
echo "  ✓ pnpm $(pnpm --version)"

# ── Step 3: llama.cpp ─────────────────────────────────────────────────────────
echo ""
echo "[3/5] Setting up llama.cpp..."

LLAMA_DIR="$HOME/.pluribus-llama"

if [ -f "$LLAMA_DIR/llama-server" ] || [ -f "$LLAMA_DIR/server" ]; then
  echo "  ✓ llama.cpp already built at $LLAMA_DIR"
else
  echo "  Cloning and building llama.cpp (this takes 2-5 min)..."
  mkdir -p "$LLAMA_DIR"

  if [ ! -d "$LLAMA_DIR/src" ]; then
    git clone --depth 1 https://github.com/ggerganov/llama.cpp "$LLAMA_DIR/src" 2>&1 | tail -3
  fi

  cd "$LLAMA_DIR/src"

  if $IS_TERMUX; then
    # Termux: use clang + no GPU
    cmake -B build -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
      -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ \
      -DCMAKE_EXE_LINKER_FLAGS="-fuse-ld=lld" 2>&1 | tail -3
  else
    cmake -B build -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF 2>&1 | tail -3
  fi

  cmake --build build --config Release -j$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2) \
    --target llama-server 2>&1 | tail -5

  # Copy binary
  if [ -f build/bin/llama-server ]; then
    cp build/bin/llama-server "$LLAMA_DIR/llama-server"
  elif [ -f build/bin/server ]; then
    cp build/bin/server "$LLAMA_DIR/llama-server"
  fi

  if [ -f "$LLAMA_DIR/llama-server" ]; then
    chmod +x "$LLAMA_DIR/llama-server"
    echo "  ✓ llama.cpp built at $LLAMA_DIR/llama-server"
  else
    echo "  ! llama.cpp build failed — you can still use remote nodes"
  fi
fi

# ── Step 4: Clone Pluribus ────────────────────────────────────────────────────
echo ""
echo "[4/5] Fetching Pluribus source..."

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Updating existing installation..."
  cd "$INSTALL_DIR" && git pull --ff-only 2>&1 | tail -2
else
  echo "  Cloning into $INSTALL_DIR ..."
  git clone "$REPO" "$INSTALL_DIR" 2>&1 | tail -3
fi
echo "  ✓ Source ready at $INSTALL_DIR"

# ── Step 5: Install Node deps ─────────────────────────────────────────────────
echo ""
echo "[5/5] Installing Node.js dependencies..."
cd "$INSTALL_DIR"
npm install 2>&1 | tail -3
echo "  ✓ Dependencies installed"

# ── Install CLI launcher ──────────────────────────────────────────────────────
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/pluribus" << LAUNCHER
#!/usr/bin/env bash
exec node "$INSTALL_DIR/cli/src/index.js" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/pluribus"

cat > "$BIN_DIR/pluribus-coordinator" << LAUNCHER
#!/usr/bin/env bash
exec node "$INSTALL_DIR/coordinator/src/index.js" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/pluribus-coordinator"

cat > "$BIN_DIR/pluribus-node" << LAUNCHER
#!/usr/bin/env bash
exec node "$INSTALL_DIR/node/src/index.js" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/pluribus-node"

# Add to PATH if needed
if ! echo "$PATH" | grep -q "$BIN_DIR"; then
  SHELL_RC="$HOME/.bashrc"
  [ -f "$HOME/.zshrc" ] && SHELL_RC="$HOME/.zshrc"
  echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$SHELL_RC"
  export PATH="$BIN_DIR:$PATH"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "  ✓ Pluribus installed successfully!"
echo ""
echo "  Quick start:"
echo ""
echo "  1. Start the coordinator:"
echo "     pluribus-coordinator"
echo ""
echo "  2. Start a node (with a running llama.cpp server):"
echo "     LLAMA_URL=http://localhost:8080 LLAMA_MODEL=smollm2-360m pluribus-node"
echo ""
echo "  3. Chat with the swarm:"
echo "     pluribus chat 'What is the nature of consciousness?'"
echo "     pluribus repl"
echo ""
echo "  4. Or use the SDK:"
echo "     import { Pluribus } from '$INSTALL_DIR/sdk/src/index.js';"
echo "     const p = new Pluribus();"
echo "     const { answer } = await p.chat('Hello, swarm');"
echo ""
echo "  Docs: https://github.com/elevate-foundry/pluribus"
echo ""
