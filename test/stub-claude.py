#!/usr/bin/env python3
"""Stub `claude` CLI for tests.

Mimics the subset of claude CLI behavior the harness wrapper consumes:
- Reads `-p <prompt>` and other flags it ignores (--output-format,
  --verbose, --model, --allowedTools).
- Emits stream-json events to stdout:
    {"type":"system","subtype":"init","session_id":"..."}
    {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
    {"type":"result","result":"...","session_id":"..."}

Behavior is controlled via env vars so tests can drive failure modes:
  STUB_MODE=normal     (default) emit a short echo response
  STUB_MODE=apology    emit an error-like apology response
  STUB_MODE=apierror   emit an API-error-shaped result
  STUB_MODE=hang       sleep until killed (tests hard ceiling)
  STUB_MODE=tool       emit a tool_use event then a normal response
  STUB_MODE=multiline  emit multiple text deltas
  STUB_MODE=noresult   exit 0 but never emit a result event

Optional STUB_SLEEP_MS injects a small delay before the result event.
"""
from __future__ import annotations

import json
import os
import sys
import time


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> int:
    mode = os.environ.get("STUB_MODE", "normal")

    prompt = ""
    argv = sys.argv[1:]
    i = 0
    while i < len(argv):
        if argv[i] == "-p" and i + 1 < len(argv):
            prompt = argv[i + 1]
            i += 2
            continue
        i += 1

    if mode == "hang":
        time.sleep(60)
        return 0

    sleep_ms = int(os.environ.get("STUB_SLEEP_MS", "0"))

    session_id = "stub-session-1"
    emit({"type": "system", "subtype": "init", "session_id": session_id})

    if mode == "tool":
        emit(
            {
                "type": "content_block_start",
                "content_block": {"type": "tool_use", "name": "Read"},
            }
        )
        emit(
            {
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": "I read a file. "},
            }
        )
        result_text = "I read a file. Done."
    elif mode == "apology":
        result_text = "Sorry, I hit an error processing that request."
        emit(
            {
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": result_text},
            }
        )
    elif mode == "apierror":
        result_text = (
            'API Error: {"type":"error","error":{"type":"overloaded_error",'
            '"message":"please try again later"}}'
        )
        emit(
            {
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": result_text},
            }
        )
    elif mode == "noresult":
        emit(
            {
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": "partial output"},
            }
        )
        # exit without a result event
        return 0
    elif mode == "multiline":
        for word in ["Hello ", "world ", "from ", "the ", "stub."]:
            emit(
                {
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": word},
                }
            )
        result_text = "Hello world from the stub."
    else:
        result_text = f"You said: {prompt[:120]}"
        emit(
            {
                "type": "content_block_delta",
                "delta": {"type": "text_delta", "text": result_text},
            }
        )

    if sleep_ms > 0:
        time.sleep(sleep_ms / 1000.0)

    emit({"type": "result", "result": result_text, "session_id": session_id})
    return 0


if __name__ == "__main__":
    sys.exit(main())
