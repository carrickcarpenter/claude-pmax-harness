#!/usr/bin/env bash
# Transcribe an audio file to stdout using faster-whisper.
# Usage: scripts/transcribe.sh <audio-file>
#
# Requires `scripts/install-transcribe.sh` to have been run first.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <audio-file>" >&2
  exit 1
fi

INPUT="$1"
DATA_DIR="${HARNESS_DATA_DIR:-$HOME/.claude-pmax-harness}"
VENV_DIR="$DATA_DIR/transcribe-venv"
MODEL="${TRANSCRIBE_MODEL:-tiny.en}"

if [ ! -x "$VENV_DIR/bin/python3" ]; then
  echo "ERROR: transcribe venv not found at $VENV_DIR" >&2
  echo "Run scripts/install-transcribe.sh first." >&2
  exit 1
fi

"$VENV_DIR/bin/python3" - <<PYEOF
import sys
from faster_whisper import WhisperModel

model = WhisperModel("$MODEL", device="cpu", compute_type="int8")
segments, info = model.transcribe("$INPUT", beam_size=1)
parts = [seg.text for seg in segments]
print("".join(parts).strip())
PYEOF
