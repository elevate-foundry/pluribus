#!/usr/bin/env bash
# Pluribus Swarm Bootstrap
# Installs all dependencies, downloads a starter model, and sets up the swarm.
# Usage: curl -fsSL https://raw.githubusercontent.com/elevate-foundry/pluribus/master/bootstrap.sh | bash

set -euo pipefail

REPO="https://github.com/elevate-foundry/pluribus.git"
INSTALL_DIR="$HOME/.pluribus-runtime"
BIN_DIR="$HOME/.local/bin"
MODELS_DIR="$HOME/models"
LLAMA_DIR="$HOME/.pluribus-llama"

# Default starter model — SmolLM2-360M Q4 (~200MB, fast on any CPU)
MODEL_URL="https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct-GGUF/resolve/main/smollm2-360m-instruct-q4_k_m.gguf"
MODEL_FILE="smollm2-360m-q4.gguf"

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
    fedora)                                 PKG_MGR="dnf" ;;
    rhel|centos|rocky|almalinux|ol)        PKG_MGR="dnf" ;;
    arch|manjaro|endeavouros|garuda)       PKG_MGR="pacman"; IS_ARCH=true ;;
    opensuse*|sles)                        PKG_MGR="zypper"; IS_OPENSUSE=true ;;
    *)                                     PKG_MGR="apt" ;;
  esac
else
  PKG_MGR="apt"
fi

echo "==> Detected environment: ${PKG_MGR}"

# ── Step 1: System dependencies ───────────────────────────────────────────────
echo ""
echo "[1/6] Installing system dependencies..."

if $IS_TERMUX; then
  pkg update -y 2>&1 | tail -3
  pkg install -y git curl nodejs cmake make clang binutils 2>&1 | tail -3
elif $IS_MACOS; then
  if ! command -v brew &>/dev/null; then
    echo "  Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
  brew install git curl node cmake 2>&1 | tail -3
elif [ "$PKG_MGR" = "apt" ]; then
  sudo apt-get update -qq
  sudo apt-get install -y git curl build-essential cmake 2>&1 | tail -3
elif [ "$PKG_MGR" = "dnf" ]; then
  sudo dnf install -y git curl gcc gcc-c++ make cmake 2>&1 | tail -3
elif $IS_ARCH; then
  sudo pacman -S --noconfirm git curl base-devel cmake 2>&1 | tail -3
elif $IS_OPENSUSE; then
  sudo zypper install -y git curl gcc gcc-c++ make cmake 2>&1 | tail -3
fi

echo "  ✓ System dependencies installed"

# ── Step 2: Node.js ───────────────────────────────────────────────────────────
echo ""
echo "[2/6] Setting up Node.js..."

if $IS_TERMUX || $IS_MACOS; then
  echo "  ✓ Node.js $(node --version)"
elif ! command -v node &>/dev/null; then
  echo "  Installing Node.js 22 via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - 2>/dev/null || true
  if [ "$PKG_MGR" = "apt" ]; then sudo apt-get install -y nodejs; fi
  if [ "$PKG_MGR" = "dnf" ]; then sudo dnf install -y nodejs; fi
  echo "  ✓ Node.js $(node --version)"
else
  echo "  ✓ Node.js $(node --version) (already installed)"
fi

if ! command -v pnpm &>/dev/null; then
  npm install -g pnpm 2>&1 | tail -1
fi
echo "  ✓ pnpm $(pnpm --version)"

# ── Step 3: llama.cpp ─────────────────────────────────────────────────────────
echo ""
echo "[3/6] Setting up llama.cpp..."

if [ -f "$LLAMA_DIR/llama-server" ]; then
  echo "  ✓ llama.cpp already built at $LLAMA_DIR/llama-server"
else
  echo "  Cloning and building llama.cpp (2-5 min)..."
  mkdir -p "$LLAMA_DIR"

  if [ ! -d "$LLAMA_DIR/src" ]; then
    git clone --depth 1 https://github.com/ggerganov/llama.cpp "$LLAMA_DIR/src" 2>&1 | tail -3
  fi

  cd "$LLAMA_DIR/src"

  if $IS_TERMUX; then
    cmake -B build -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
      -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ \
      -DCMAKE_EXE_LINKER_FLAGS="-fuse-ld=lld" 2>&1 | tail -3
  else
    cmake -B build -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF 2>&1 | tail -3
  fi

  NPROC=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)
  cmake --build build --config Release -j"$NPROC" --target llama-server 2>&1 | tail -5

  BUILT=""
  [ -f build/bin/llama-server ] && BUILT="build/bin/llama-server"
  [ -f build/bin/server ]       && BUILT="build/bin/server"

  if [ -n "$BUILT" ]; then
    cp "$BUILT" "$LLAMA_DIR/llama-server"
    chmod +x "$LLAMA_DIR/llama-server"
    echo "  ✓ llama.cpp built: $LLAMA_DIR/llama-server"
  else
    echo "  ! llama.cpp build failed — check $LLAMA_DIR/src/build for errors"
    echo "  ! You can still use remote nodes without a local model"
  fi
fi

# ── Step 4: Download starter model ───────────────────────────────────────────
echo ""
echo "[4/6] Downloading starter model (SmolLM2-360M ~200MB)..."

mkdir -p "$MODELS_DIR"

if [ -f "$MODELS_DIR/$MODEL_FILE" ]; then
  echo "  ✓ Model already present: $MODELS_DIR/$MODEL_FILE"
else
  echo "  Downloading $MODEL_FILE from HuggingFace..."
  if command -v wget &>/dev/null; then
    wget -q --show-progress -O "$MODELS_DIR/$MODEL_FILE" "$MODEL_URL" 2>&1 || \
      curl -L --progress-bar -o "$MODELS_DIR/$MODEL_FILE" "$MODEL_URL"
  else
    curl -L --progress-bar -o "$MODELS_DIR/$MODEL_FILE" "$MODEL_URL"
  fi

  if [ -f "$MODELS_DIR/$MODEL_FILE" ] && [ -s "$MODELS_DIR/$MODEL_FILE" ]; then
    SIZE=$(du -sh "$MODELS_DIR/$MODEL_FILE" | cut -f1)
    echo "  ✓ Model downloaded: $MODELS_DIR/$MODEL_FILE ($SIZE)"
  else
    echo "  ! Model download failed — you can download manually:"
    echo "    wget -O ~/models/$MODEL_FILE '$MODEL_URL'"
  fi
fi

# ── Step 5: Clone Pluribus ────────────────────────────────────────────────────
echo ""
echo "[5/6] Fetching Pluribus source..."

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  Updating existing installation..."
  cd "$INSTALL_DIR" && git pull --ff-only 2>&1 | tail -2
else
  echo "  Cloning into $INSTALL_DIR ..."
  git clone "$REPO" "$INSTALL_DIR" 2>&1 | tail -3
fi
echo "  ✓ Source ready at $INSTALL_DIR"

# ── Step 6: Install Node deps ─────────────────────────────────────────────────
echo ""
echo "[6/6] Installing Node.js dependencies..."
cd "$INSTALL_DIR"
npm install 2>&1 | tail -3
echo "  ✓ Dependencies installed"

# ── Install CLI launchers ─────────────────────────────────────────────────────
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/pluribus" << LAUNCHER
#!/usr/bin/env bash
exec node "$INSTALL_DIR/cli/src/index.js" "\$@"
LAUNCHER

cat > "$BIN_DIR/pluribus-coordinator" << LAUNCHER
#!/usr/bin/env bash
exec node "$INSTALL_DIR/coordinator/src/index.js" "\$@"
LAUNCHER

cat > "$BIN_DIR/pluribus-node" << LAUNCHER
#!/usr/bin/env bash
LLAMA_SERVER="$LLAMA_DIR/llama-server"
MODEL_PATH="$MODELS_DIR/$MODEL_FILE"
export LLAMA_URL="\${LLAMA_URL:-http://localhost:8080}"
export LLAMA_MODEL="\${LLAMA_MODEL:-smollm2-360m}"
export LLAMA_ROLE="\${LLAMA_ROLE:-proposer}"
export PLURIBUS_COORDINATOR="\${PLURIBUS_COORDINATOR:-http://localhost:7779}"
exec node "$INSTALL_DIR/node/src/index.js" "\$@"
LAUNCHER

chmod +x "$BIN_DIR/pluribus" "$BIN_DIR/pluribus-coordinator" "$BIN_DIR/pluribus-node"

# ── PATH — fix for current session AND future sessions ───────────────────────
export PATH="$BIN_DIR:$PATH"

SHELL_RC="$HOME/.bashrc"
[ -n "${ZSH_VERSION:-}" ] && SHELL_RC="$HOME/.zshrc"
[ -f "$HOME/.zshrc" ] && SHELL_RC="$HOME/.zshrc"

PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""
if ! grep -qF "$BIN_DIR" "$SHELL_RC" 2>/dev/null; then
  echo "$PATH_LINE" >> "$SHELL_RC"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "  ╔══════════════════════════════════════════════════════════════╗"
echo "  ║  Pluribus installed successfully!                           ║"
echo "  ╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  PATH is active in this session. Run each command below in order:"
echo ""
echo "  ── Step 1: Start the coordinator (in one terminal tab) ──────────"
echo ""
echo "     pluribus-coordinator"
echo ""
echo "  ── Step 2: Start a node (in a second terminal tab) ─────────────"
echo ""
echo "     pluribus-node"
echo ""
echo "     (This starts llama.cpp with $MODEL_FILE automatically)"
echo ""
echo "  ── Step 3: Chat with the swarm ──────────────────────────────────"
echo ""
echo "     pluribus repl"
echo ""
echo "  Or one-shot:"
echo "     pluribus chat 'What is the nature of consciousness?'"
echo ""
echo "  Docs: https://github.com/elevate-foundry/pluribus"
echo ""
echo "  Note: If you open a new terminal, PATH is already saved to $SHELL_RC"
echo ""
