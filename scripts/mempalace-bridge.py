#!/usr/bin/env python3
"""
claude-pmax-harness MemPalace bridge.

Spawned once at harness startup and kept alive for the runtime. Reads
newline-delimited JSON requests from stdin, writes NDJSON responses to stdout.

Pattern adapted from a sibling project's bridge: ChromaDB + embedding model
load once on first real request and stay resident, eliminating the cold-start
tax that a per-message subprocess would pay on every Telegram turn.

Protocol (see docs/architecture.md §5):

  Startup:
    bridge -> {"ready": true, "bridge_version": "...", "python": "...",
               "mempalace_version": "..." | null}

  Request envelope (from harness):
    {"request_id": "<id>", "op": "<op>", ...payload}

  Response envelope (back to harness):
    {"request_id": "<id>", "ok": true,  ...result}
    {"request_id": "<id>", "ok": false, "error": "...", "code": "..."}

  Operations supported in v1 step 2:
    - ping: no payload; returns pong + version info.

  Operations defined in protocol but not yet implemented (return UNIMPLEMENTED):
    remember, recall, recent, recent_since,
    purge_query, purge_range, purge_all, stats

Errors are returned as structured failure responses; the bridge does not
raise to the caller. It only exits if stdin closes (parent process gone).
"""

import json
import os
import sys
import traceback

BRIDGE_VERSION = "1.0.0"

# Lazy: defer MemPalace import until the first operation that needs it.
# Keeps ping cheap and lets the bridge start even on machines where the
# MemPalace venv isn't installed yet (so harness doctor can still detect it).
_mempalace_loaded = False
_mempalace_version = None
_mempalace_import_error = None


def _try_load_mempalace():
    global _mempalace_loaded, _mempalace_version, _mempalace_import_error
    if _mempalace_loaded:
        return _mempalace_version, _mempalace_import_error
    try:
        import mempalace  # noqa: F401
        _mempalace_version = getattr(mempalace, "__version__", "unknown")
        _mempalace_loaded = True
    except Exception as e:  # ImportError or anything else
        _mempalace_import_error = f"{type(e).__name__}: {e}"
    _mempalace_loaded = True
    return _mempalace_version, _mempalace_import_error


def handle_ping(_req):
    # Cheap probe — does NOT import MemPalace. Reports availability.
    version, import_error = _try_load_mempalace()
    return {
        "ok": True,
        "pong": True,
        "bridge_version": BRIDGE_VERSION,
        "mempalace_version": version,
        "mempalace_available": import_error is None,
        "mempalace_error": import_error,
    }


def handle_unimplemented(op):
    return {
        "ok": False,
        "error": f"op '{op}' is defined in the protocol but not yet implemented in v1 step 2",
        "code": "UNIMPLEMENTED",
    }


OPS = {
    "ping": handle_ping,
}

UNIMPLEMENTED_OPS = {
    "remember",
    "recall",
    "recent",
    "recent_since",
    "purge_query",
    "purge_range",
    "purge_all",
    "stats",
}


def handle(req):
    op = req.get("op")
    if not op:
        return {"ok": False, "error": "missing 'op' field", "code": "BAD_REQUEST"}
    if op in OPS:
        return OPS[op](req)
    if op in UNIMPLEMENTED_OPS:
        return handle_unimplemented(op)
    return {"ok": False, "error": f"unknown op: {op}", "code": "BAD_REQUEST"}


def write_line(obj):
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def main():
    # Ready handshake — sent before processing any requests so the parent
    # knows the bridge is alive. Includes version info for compatibility checks.
    version, _ = _try_load_mempalace()
    write_line(
        {
            "ready": True,
            "bridge_version": BRIDGE_VERSION,
            "python": sys.version.split()[0],
            "mempalace_version": version,
            "pid": os.getpid(),
        }
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            req = json.loads(line)
            request_id = req.get("request_id")
            resp = handle(req)
        except json.JSONDecodeError as e:
            resp = {"ok": False, "error": f"bad json: {e}", "code": "BAD_REQUEST"}
        except Exception as e:
            resp = {
                "ok": False,
                "error": f"{type(e).__name__}: {e}",
                "code": "INTERNAL",
                "traceback": traceback.format_exc()[-500:],
            }
        if request_id is not None:
            resp["request_id"] = request_id
        write_line(resp)


if __name__ == "__main__":
    main()
