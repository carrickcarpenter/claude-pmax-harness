#!/usr/bin/env bash
# Install (or upgrade) MemPalace into the harness's Python venv.
# Idempotent — re-running is safe.
#
# Default venv location: ~/.claude-pmax-harness/venv
# Override with HARNESS_DATA_DIR env var.

set -euo pipefail

DATA_DIR="${HARNESS_DATA_DIR:-$HOME/.claude-pmax-harness}"
VENV_DIR="$DATA_DIR/venv"
# Portable script-dir resolution — works on Linux + macOS (BSD readlink lacks -f).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REQ_FILE="$SCRIPT_DIR/../requirements/mempalace.txt"
PYTHON="${PYTHON:-python3}"

if [ ! -f "$REQ_FILE" ]; then
  echo "ERROR: requirements file not found at $REQ_FILE" >&2
  exit 1
fi

mkdir -p "$DATA_DIR"

# Create venv if missing
if [ ! -x "$VENV_DIR/bin/python3" ]; then
  echo "[install-mempalace] Creating venv at $VENV_DIR"
  "$PYTHON" -m venv "$VENV_DIR"
fi

# Verify Python version inside venv
VENV_PYV=$("$VENV_DIR/bin/python3" --version 2>&1)
echo "[install-mempalace] Venv Python: $VENV_PYV"

# Upgrade pip + install pinned requirements
"$VENV_DIR/bin/python3" -m pip install --quiet --upgrade pip
"$VENV_DIR/bin/python3" -m pip install --quiet -r "$REQ_FILE"

# Verify MemPalace can be imported (catches broken installs early)
if "$VENV_DIR/bin/python3" -c "import mempalace" 2>/dev/null; then
  MP_VERSION=$("$VENV_DIR/bin/python3" -c "import mempalace; print(getattr(mempalace, '__version__', 'unknown'))" 2>/dev/null || echo "unknown")
  echo "[install-mempalace] OK — mempalace==$MP_VERSION installed at $VENV_DIR"
else
  echo "ERROR: mempalace installed but import failed. Inspect $VENV_DIR" >&2
  exit 1
fi
