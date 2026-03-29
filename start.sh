#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  Pluribus — All-in-one start script                             ║
# ║  Downloads everything, clears ports, starts the full swarm.    ║
# ║  Usage: bash start.sh                                           ║
# ╚══════════════════════════════════════════════════════════════════╝

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
INSTALL_DIR="$HOME/.pluribus-runtime"
LLAMA_DIR="$HOME/.pluribus-llama"
MODELS_DIR="$HOME/models"
LOG_DIR="$HOME/.pluribus-logs"
BIN_DIR="$HOME/.local/bin"
REPO="https://github.com/elevate-foundry/pluribus.git"

MODEL_FILE="smollm2-360m-q4.gguf"
MODEL_URL="https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct-GGUF/resolve/main/smollm2-360m-instruct-q4_k_m.gguf"

PORT_LLAMA=8080        # llama.cpp inference server
PORT_NODE=7778         # Pluribus node
PORT_COORD=7779        # Pluribus coordinator

# ── Detect environment ────────────────────────────────────────────────────────
IS_TERMUX=false
if [ -n "${TERMUX_VERSION:-}" ] || [ -d "/data/data/com.termux" ]; then
  IS_TERMUX=true
fi

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
ok()   { echo -e "${GREEN}  ✓${RESET} $*"; }
info() { echo -e "${CYAN}  →${RESET} $*"; }
warn() { echo -e "${YELLOW}  !${RESET} $*"; }
die()  { echo -e "${RED}  ✗ FATAL:${RESET} $*"; exit 1; }

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}"
echo "  ██████╗ ██╗     ██╗   ██╗██████╗ ██╗██████╗ ██╗   ██╗███████╗"
echo "  ██╔══██╗██║     ██║   ██║██╔══██╗██║██╔══██╗██║   ██║██╔════╝"
echo "  ██████╔╝██║     ██║   ██║██████╔╝██║██████╔╝██║   ██║███████╗"
echo "  ██╔═══╝ ██║     ██║   ██║██╔══██╗██║██╔══██╗██║   ██║╚════██║"
echo "  ██║     ███████╗╚██████╔╝██║  ██║██║██████╔╝╚██████╔╝███████║"
echo "  ╚═╝     ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝ ╚══════╝"
echo -e "${RESET}"
echo -e "  ${BOLD}Distributed AI swarm — all-in-one launcher${RESET}"
echo ""

mkdir -p "$LOG_DIR" "$MODELS_DIR" "$BIN_DIR"

# ════════════════════════════════════════════════════════════════════
# 1. KILL ANYTHING ON OUR PORTS
# ════════════════════════════════════════════════════════════════════
echo -e "${BOLD}[1/6] Clearing ports $PORT_LLAMA, $PORT_NODE, $PORT_COORD...${RESET}"

kill_port() {
  local port=$1
  local pids=""
  # Try fuser first (most portable), then lsof, then ss+awk
  if command -v fuser &>/dev/null; then
    pids=$(fuser "${port}/tcp" 2>/dev/null | tr ' ' '\n' | grep -v '^$' || true)
  elif command -v lsof &>/dev/null; then
    pids=$(lsof -ti :"$port" 2>/dev/null || true)
  elif command -v ss &>/dev/null; then
    pids=$(ss -tlnp "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' || true)
  fi

  if [ -n "$pids" ]; then
    echo "$pids" | xargs -r kill -9 2>/dev/null || true
    warn "Killed process(es) on port $port: $pids"
  else
    ok "Port $port is free"
  fi
}

kill_port $PORT_LLAMA
kill_port $PORT_NODE
kill_port $PORT_COORD
sleep 1

# ════════════════════════════════════════════════════════════════════
# 2. ENSURE SYSTEM DEPENDENCIES
# ════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}[2/6] Checking system dependencies...${RESET}"

install_if_missing() {
  local cmd=$1; shift
  if ! command -v "$cmd" &>/dev/null; then
    info "Installing $cmd..."
    if $IS_TERMUX; then
      pkg install -y "$@" 2>&1 | tail -2
    elif [ -f /etc/os-release ]; then
      . /etc/os-release 2>/dev/null || true
      case "${ID:-}" in
        ubuntu|debian|raspbian|pop|linuxmint)
          sudo apt-get install -y "$@" 2>&1 | tail -2 ;;
        fedora|rhel|centos|rocky|almalinux)
          sudo dnf install -y "$@" 2>&1 | tail -2 ;;
        arch|manjaro|endeavouros)
          sudo pacman -S --noconfirm "$@" 2>&1 | tail -2 ;;
        opensuse*)
          sudo zypper install -y "$@" 2>&1 | tail -2 ;;
        *)
          sudo apt-get install -y "$@" 2>&1 | tail -2 ;;
      esac
    elif [ "$(uname -s)" = "Darwin" ]; then
      brew install "$@" 2>&1 | tail -2
    fi
  fi
}

install_if_missing git git
install_if_missing curl curl
install_if_missing node nodejs
install_if_missing cmake cmake

if ! command -v pnpm &>/dev/null; then
  info "Installing pnpm..."
  npm install -g pnpm 2>&1 | tail -1
fi

ok "Node.js $(node --version) | pnpm $(pnpm --version)"

# ════════════════════════════════════════════════════════════════════
# 3. DOWNLOAD MODEL IF MISSING
# ════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}[3/6] Checking model...${RESET}"

MODEL_PATH="$MODELS_DIR/$MODEL_FILE"

if [ -f "$MODEL_PATH" ] && [ -s "$MODEL_PATH" ]; then
  SIZE=$(du -sh "$MODEL_PATH" | cut -f1)
  ok "Model ready: $MODEL_PATH ($SIZE)"
else
  info "Downloading SmolLM2-360M (~200MB)..."
  if command -v wget &>/dev/null; then
    wget -q --show-progress -O "$MODEL_PATH" "$MODEL_URL" || \
      curl -L --progress-bar -o "$MODEL_PATH" "$MODEL_URL"
  else
    curl -L --progress-bar -o "$MODEL_PATH" "$MODEL_URL"
  fi
  [ -s "$MODEL_PATH" ] && ok "Model downloaded: $MODEL_PATH" || die "Model download failed"
fi

# ════════════════════════════════════════════════════════════════════
# 4. BUILD LLAMA.CPP IF MISSING
# ════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}[4/6] Checking llama.cpp...${RESET}"

LLAMA_BIN="$LLAMA_DIR/llama-server"

if [ -f "$LLAMA_BIN" ]; then
  ok "llama.cpp binary ready: $LLAMA_BIN"
else
  info "Building llama.cpp (first time only, ~3-5 min)..."

  if $IS_TERMUX; then
    pkg install -y clang lld binutils make cmake 2>&1 | tail -2
  fi

  mkdir -p "$LLAMA_DIR"
  if [ ! -d "$LLAMA_DIR/src/.git" ]; then
    git clone --depth 1 https://github.com/ggerganov/llama.cpp "$LLAMA_DIR/src" 2>&1 | tail -3
  fi

  cd "$LLAMA_DIR/src"
  NPROC=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)

  if $IS_TERMUX; then
    cmake -B build \
      -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF \
      -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ \
      -DCMAKE_EXE_LINKER_FLAGS="-fuse-ld=lld" 2>&1 | tail -3
  else
    cmake -B build -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF 2>&1 | tail -3
  fi

  cmake --build build --config Release -j"$NPROC" --target llama-server 2>&1 | tail -5

  for candidate in build/bin/llama-server build/bin/server; do
    [ -f "$candidate" ] && cp "$candidate" "$LLAMA_BIN" && break
  done

  [ -f "$LLAMA_BIN" ] && chmod +x "$LLAMA_BIN" && ok "llama.cpp built: $LLAMA_BIN" \
    || die "llama.cpp build failed — check $LLAMA_DIR/src/build for errors"
fi

# ════════════════════════════════════════════════════════════════════
# 5. CLONE / UPDATE PLURIBUS SOURCE
# ════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}[5/6] Fetching Pluribus source...${RESET}"

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation..."
  cd "$INSTALL_DIR" && git pull --ff-only 2>&1 | tail -2
else
  git clone "$REPO" "$INSTALL_DIR" 2>&1 | tail -3
fi

cd "$INSTALL_DIR"
npm install --silent 2>&1 | tail -2
ok "Source ready: $INSTALL_DIR"

# ════════════════════════════════════════════════════════════════════
# 6. START ALL PROCESSES
# ════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}[6/6] Starting the swarm...${RESET}"

THREADS=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)

# ── Helper: start a background process with a log file ───────────────────────
start_bg() {
  local name=$1; shift
  local log="$LOG_DIR/${name}.log"
  echo "" > "$log"   # clear old log
  "$@" >> "$log" 2>&1 &
  echo $!
}

# ── Helper: wait for an HTTP endpoint to become healthy ──────────────────────
wait_for() {
  local name=$1
  local url=$2
  local max=${3:-300}
  local logfile=${4:-""}
  local i=0
  printf "  Waiting for %-20s" "$name..."
  while [ $i -lt $max ]; do
    if curl -sf "$url" -o /dev/null 2>/dev/null; then
      echo -e " ${GREEN}ready${RESET}"
      return 0
    fi
    # Check if the process died
    if [ -n "$logfile" ] && grep -qi 'error\|fatal\|failed\|exiting' "$logfile" 2>/dev/null; then
      echo -e " ${RED}crashed${RESET}"
      echo ""
      echo -e "  ${RED}Last log lines from $logfile:${RESET}"
      tail -20 "$logfile"
      echo ""
      return 1
    fi
    printf "."
    sleep 2
    i=$((i+2))
  done
  echo -e " ${RED}timed out${RESET}"
  [ -n "$logfile" ] && echo "  Last log:" && tail -10 "$logfile"
  return 1
}

# ── 6a. llama.cpp ─────────────────────────────────────────────────────────────
info "Starting llama.cpp on port $PORT_LLAMA..."
# Use -c 512 on Termux to reduce memory usage; remove --log-disable so we can see errors
CTX_SIZE=2048
$IS_TERMUX && CTX_SIZE=512
LLAMA_PID=$(start_bg "llama" \
  "$LLAMA_BIN" \
    -m "$MODEL_PATH" \
    --port "$PORT_LLAMA" \
    --host 127.0.0.1 \
    -t "$THREADS" \
    -c "$CTX_SIZE" \
    -np 1 \
)
wait_for "llama.cpp" "http://127.0.0.1:$PORT_LLAMA/health" 300 "$LOG_DIR/llama.log" \
  || { warn "llama.cpp failed to start — check $LOG_DIR/llama.log"; }

# ── 6b. Coordinator ───────────────────────────────────────────────────────────
info "Starting coordinator on port $PORT_COORD..."
COORD_PID=$(start_bg "coordinator" \
  node "$INSTALL_DIR/coordinator/src/index.js"
)
wait_for "coordinator" "http://127.0.0.1:$PORT_COORD/v1/health" 30 "$LOG_DIR/coordinator.log"

# ── 6c. Node (proposer) ───────────────────────────────────────────────────────
info "Starting swarm node on port $PORT_NODE..."
NODE_PID=$(LLAMA_URL="http://127.0.0.1:$PORT_LLAMA" \
  LLAMA_MODEL="smollm2-360m" \
  LLAMA_ROLE="proposer" \
  LLAMA_AUTO_START="false" \
  PLURIBUS_COORDINATOR="http://127.0.0.1:$PORT_COORD" \
  NODE_PORT="$PORT_NODE" \
  start_bg "node" node "$INSTALL_DIR/node/src/index.js"
)
wait_for "node" "http://127.0.0.1:$PORT_NODE/health" 30 "$LOG_DIR/node.log"

# ── Write PID file for stop.sh ────────────────────────────────────────────────
cat > "$LOG_DIR/pids" << EOF
LLAMA_PID=$LLAMA_PID
COORD_PID=$COORD_PID
NODE_PID=$NODE_PID
EOF

# ── Install CLI launchers (idempotent) ────────────────────────────────────────
cat > "$BIN_DIR/pluribus" << LAUNCHER
#!/usr/bin/env bash
exec node "$INSTALL_DIR/cli/src/index.js" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/pluribus"

export PATH="$BIN_DIR:$PATH"
SHELL_RC="$HOME/.bashrc"
[ -f "$HOME/.zshrc" ] && SHELL_RC="$HOME/.zshrc"
grep -qF "$BIN_DIR" "$SHELL_RC" 2>/dev/null || echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$SHELL_RC"

# ── Also write a stop.sh ──────────────────────────────────────────────────────
cat > "$HOME/.pluribus-runtime/stop.sh" << 'STOP'
#!/usr/bin/env bash
LOG_DIR="$HOME/.pluribus-logs"
if [ -f "$LOG_DIR/pids" ]; then
  source "$LOG_DIR/pids"
  for pid in $LLAMA_PID $COORD_PID $NODE_PID; do
    kill "$pid" 2>/dev/null && echo "Killed PID $pid" || true
  done
  rm -f "$LOG_DIR/pids"
  echo "Swarm stopped."
else
  echo "No running swarm found."
fi
STOP
chmod +x "$HOME/.pluribus-runtime/stop.sh"

# ════════════════════════════════════════════════════════════════════
# DONE
# ════════════════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}${BOLD}  ╔══════════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}${BOLD}  ║  Swarm is running!                                  ║${RESET}"
echo -e "${GREEN}${BOLD}  ╚══════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${BOLD}Processes:${RESET}"
echo -e "    llama.cpp   → http://127.0.0.1:$PORT_LLAMA  (PID $LLAMA_PID)"
echo -e "    coordinator → http://127.0.0.1:$PORT_COORD  (PID $COORD_PID)"
echo -e "    node        → http://127.0.0.1:$PORT_NODE  (PID $NODE_PID)"
echo ""
echo -e "  ${BOLD}Logs:${RESET}  $LOG_DIR/"
echo -e "    tail -f $LOG_DIR/llama.log"
echo -e "    tail -f $LOG_DIR/coordinator.log"
echo -e "    tail -f $LOG_DIR/node.log"
echo ""
echo -e "  ${BOLD}Chat:${RESET}"
echo -e "    pluribus repl"
echo -e "    pluribus chat 'What is the nature of consciousness?'"
echo ""
echo -e "  ${BOLD}Stop:${RESET}"
echo -e "    bash ~/.pluribus-runtime/stop.sh"
echo ""
echo -e "  Starting interactive REPL in 3 seconds... (Ctrl+C to skip)"
sleep 3 && exec node "$INSTALL_DIR/cli/src/index.js" repl || true
