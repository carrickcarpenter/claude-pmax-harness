import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { MemPalaceBridge } from "../src/memory/bridge.js";
import { ExternalError } from "../src/lib/errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// repo-root/test → repo-root/scripts/mempalace-bridge.py
const SCRIPT_PATH = resolve(__dirname, "..", "scripts", "mempalace-bridge.py");

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "harness-bridge-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function newBridge(overrides: {
  scriptPath?: string;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
} = {}) {
  return new MemPalaceBridge({
    scriptPath: overrides.scriptPath ?? SCRIPT_PATH,
    pythonPath: "python3",
    // Point at a non-existent dataDir so the constructor doesn't pick a venv python.
    dataDir: tmpRoot,
    readyTimeoutMs: overrides.readyTimeoutMs ?? 5000,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 5000,
  });
}

describe("MemPalaceBridge — real bridge script", () => {
  test("start() resolves with ready handshake including version + python", async () => {
    const bridge = newBridge();
    try {
      const ready = await bridge.start();
      expect(ready.ready).toBe(true);
      expect(ready.bridge_version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(ready.python).toMatch(/^\d+\.\d+/);
      expect(typeof ready.pid).toBe("number");
    } finally {
      bridge.close();
    }
  });

  test("ping() returns pong + bridge version + mempalace availability flag", async () => {
    const bridge = newBridge();
    try {
      const pong = await bridge.ping();
      expect(pong.pong).toBe(true);
      expect(pong.bridge_version).toMatch(/^\d+\.\d+\.\d+$/);
      // mempalace_available depends on system Python having mempalace installed;
      // we don't assert true/false — just that the field is a boolean.
      expect(typeof pong.mempalace_available).toBe("boolean");
      if (!pong.mempalace_available) {
        expect(pong.mempalace_error).not.toBeNull();
      }
    } finally {
      bridge.close();
    }
  });

  test("unknown op returns structured error, bridge stays alive", async () => {
    const bridge = newBridge();
    try {
      const resp = await bridge.request("definitely_not_a_real_op");
      expect(resp.ok).toBe(false);
      expect(resp.code).toBe("BAD_REQUEST");
      expect(resp.error).toMatch(/unknown op/);
      // bridge should still respond to subsequent requests
      const pong = await bridge.ping();
      expect(pong.pong).toBe(true);
    } finally {
      bridge.close();
    }
  });

  test("unimplemented op returns UNIMPLEMENTED error code", async () => {
    const bridge = newBridge();
    try {
      const resp = await bridge.request("recall");
      expect(resp.ok).toBe(false);
      expect(resp.code).toBe("UNIMPLEMENTED");
    } finally {
      bridge.close();
    }
  });

  test("concurrent requests are both answered (request_id routing)", async () => {
    const bridge = newBridge();
    try {
      const [a, b, c] = await Promise.all([
        bridge.request("ping"),
        bridge.request("unknown_a"),
        bridge.request("ping"),
      ]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(false);
      expect(c.ok).toBe(true);
    } finally {
      bridge.close();
    }
  });
});

describe("MemPalaceBridge — failure modes", () => {
  test("ready timeout fires when bridge never sends ready", async () => {
    const stubScript = resolve(tmpRoot, "stub-noready.py");
    // Stub that imports sys then sleeps — never writes ready
    writeFileSync(
      stubScript,
      `import time, sys\nsys.stderr.write("stub starting\\n")\ntime.sleep(60)\n`,
    );
    chmodSync(stubScript, 0o755);
    const bridge = newBridge({ scriptPath: stubScript, readyTimeoutMs: 500 });
    await expect(bridge.start()).rejects.toThrow(/ready timeout/);
    bridge.close();
  });

  test("request timeout fires when bridge sends ready but never responds", async () => {
    const stubScript = resolve(tmpRoot, "stub-noresp.py");
    writeFileSync(
      stubScript,
      [
        `import sys, time, json`,
        `sys.stdout.write(json.dumps({"ready": True, "bridge_version": "0.0.0", "python": "stub", "mempalace_version": None, "pid": 0}) + "\\n")`,
        `sys.stdout.flush()`,
        `time.sleep(60)`,
      ].join("\n"),
    );
    const bridge = newBridge({ scriptPath: stubScript, requestTimeoutMs: 500 });
    await bridge.start();
    await expect(bridge.request("ping")).rejects.toThrow(/timeout/);
    bridge.close();
  });

  test("bridge death rejects pending requests with structured error", async () => {
    const stubScript = resolve(tmpRoot, "stub-die.py");
    // Stub that signals ready, then exits as soon as it sees any request.
    writeFileSync(
      stubScript,
      [
        `import sys, json`,
        `sys.stdout.write(json.dumps({"ready": True, "bridge_version": "0.0.0", "python": "stub", "mempalace_version": None, "pid": 0}) + "\\n")`,
        `sys.stdout.flush()`,
        `# read one line then die`,
        `sys.stdin.readline()`,
        `sys.exit(1)`,
      ].join("\n"),
    );
    const bridge = newBridge({ scriptPath: stubScript, requestTimeoutMs: 5000 });
    await bridge.start();
    await expect(bridge.request("ping")).rejects.toBeInstanceOf(ExternalError);
    bridge.close();
  });
});
