#!/usr/bin/env bash
# Install faster-whisper into ~/.claude-pmax-harness/transcribe-venv/ so
# the voice handler can transcribe Telegram voice notes locally.
#
# Opt-in: voice handler works only after this script runs successfully.
# The CPU model is small (~150 MB download); first transcription warms
# the cache and takes longer than subsequent ones.

set -euo pipefail

DATA_DIR="${HARNESS_DATA_DIR:-$HOME/.claude-pmax-harness}"
VENV_DIR="$DATA_DIR/transcribe-venv"
PYTHON="${PYTHON:-python3}"

mkdir -p "$DATA_DIR"

if [ ! -x "$VENV_DIR/bin/python3" ]; then
  echo "[install-transcribe] Creating venv at $VENV_DIR"
  "$PYTHON" -m venv "$VENV_DIR"
fi

echo "[install-transcribe] Upgrading pip + installing faster-whisper"
"$VENV_DIR/bin/python3" -m pip install --quiet --upgrade pip
"$VENV_DIR/bin/python3" -m pip install --quiet "faster-whisper>=1.0"

# Sanity-check import
if "$VENV_DIR/bin/python3" -c "from faster_whisper import WhisperModel; print('ok')" >/dev/null 2>&1; then
  echo "[install-transcribe] OK — faster-whisper installed at $VENV_DIR"
  echo "[install-transcribe] First voice message will download the 'tiny.en' model (~150 MB) into the user's HuggingFace cache."
else
  echo "ERROR: faster-whisper installed but import failed. Inspect $VENV_DIR" >&2
  exit 1
fi
