#!/bin/bash
set -e

REPO="https://github.com/yjgbg-labs/memory.git"
INSTALL_DIR="${MEMORY_INSTALL_DIR:-$HOME/.local/share/memory}"
BIN_DIR="${MEMORY_BIN_DIR:-$HOME/.local/bin}"
BIN="$BIN_DIR/memory"

# ── Clone / update ─────────────────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "→ Updating existing install at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "→ Cloning into $INSTALL_DIR"
  git clone "$REPO" "$INSTALL_DIR"
fi

# ── Install dependencies ───────────────────────────────────────────────
cd "$INSTALL_DIR"
if command -v npm &>/dev/null; then
  npm install
else
  echo "! npm not found — skipping npm install"
fi

# ── Install wrapper ────────────────────────────────────────────────────
mkdir -p "$BIN_DIR"

# Detect CUDA lib path
CUDA_LIB=""
for d in /usr/lib/wsl/lib /usr/local/cuda/lib64 /usr/lib/x86_64-linux-gnu; do
  if [ -f "$d/libcuda.so" ] || [ -f "$d/libcuda.so.1" ]; then
    CUDA_LIB="$d"
    break
  fi
done

cat > "$BIN" <<'WRAPPER'
#!/bin/bash
MEMORY_HOME="MEMORY_INSTALL_DIR_PLACEHOLDER"
CUDA_LIB_PATH="CUDA_LIB_PLACEHOLDER"

if [ -n "$CUDA_LIB_PATH" ]; then
  export LD_LIBRARY_PATH="$CUDA_LIB_PATH:${LD_LIBRARY_PATH:-}"
fi

exec node "$MEMORY_HOME/memory.mjs" "$@" 2> >(grep -v 'onnxruntime\|VerifyEachNode\|Rerunning with verbose' >&2)
WRAPPER

sed -i "s|MEMORY_INSTALL_DIR_PLACEHOLDER|$INSTALL_DIR|" "$BIN"
sed -i "s|CUDA_LIB_PLACEHOLDER|$CUDA_LIB|" "$BIN"

chmod +x "$BIN"

# ── Done ───────────────────────────────────────────────────────────────
echo ""
echo "✓ memory installed to $BIN"

if ! echo "$PATH" | grep -q "$BIN_DIR"; then
  echo "  → Add $BIN_DIR to your PATH to use 'memory':"
  echo "     echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc"
fi

echo "  → Run 'memory init' to create database tables"
echo "  → Run 'memory index --watch' to start collecting events"
