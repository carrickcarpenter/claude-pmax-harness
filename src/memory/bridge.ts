import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { logger } from "../lib/logger.js";
import { ExternalError } from "../lib/errors.js";

// Node-side client for the MemPalace Python bridge.
// Implements the §17.5 resilience patterns from the architecture:
//   #1 startup ping (exposed via ping() — caller's responsibility to invoke)
//   #2 bridge respawns on death; pending callers rejected with structured error
//   #3 sequential per-connection processing via request_id callback map
//   #4 per-request timeout (15s default)
//   #6 10s readiness ceiling on the initial handshake

export interface ReadyMessage {
  ready: true;
  bridge_version: string;
  python: string;
  mempalace_version: string | null;
  pid: number;
}

export interface BridgeResponse {
  request_id?: string;
  ok: boolean;
  pong?: boolean;
  bridge_version?: string;
  mempalace_version?: string | null;
  mempalace_available?: boolean;
  mempalace_error?: string | null;
  error?: string;
  code?: string;
  [key: string]: unknown;
}

export interface PingResult {
  pong: true;
  bridge_version: string;
  mempalace_version: string | null;
  mempalace_available: boolean;
  mempalace_error: string | null;
}

export interface BridgeOptions {
  scriptPath?: string;
  pythonPath?: string;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  dataDir?: string;
}

interface PendingRequest {
  resolve: (resp: BridgeResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class MemPalaceBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: Interface | null = null;
  private readyPromise: Promise<ReadyMessage> | null = null;
  private pending = new Map<string, PendingRequest>();
  private requestIdCounter = 0;
  private readonly opts: Required<BridgeOptions>;

  constructor(opts: BridgeOptions = {}) {
    const dataDir =
      opts.dataDir ?? resolve(homedir(), ".claude-pmax-harness");
    const venvPython = resolve(dataDir, "venv", "bin", "python3");
    this.opts = {
      scriptPath: opts.scriptPath ?? defaultScriptPath(),
      pythonPath:
        opts.pythonPath ??
        (existsSync(venvPython) ? venvPython : "python3"),
      readyTimeoutMs: opts.readyTimeoutMs ?? 10_000,
      requestTimeoutMs: opts.requestTimeoutMs ?? 15_000,
      dataDir,
    };
  }

  async start(): Promise<ReadyMessage> {
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise<ReadyMessage>((resolveReady, rejectReady) => {
      let bridgeReady = false;
      let readyTimer: NodeJS.Timeout | null = null;

      const child = spawn(this.opts.pythonPath, [this.opts.scriptPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          NO_COLOR: "1",
          PYTHONUNBUFFERED: "1",
        },
      });
      this.proc = child;
      this.rl = createInterface({ input: child.stdout });

      const handleReadyLine = (raw: string): void => {
        let msg: unknown;
        try {
          msg = JSON.parse(raw);
        } catch {
          logger.error(
            { line: raw.slice(0, 200) },
            "[mempalace] bad line from bridge",
          );
          return;
        }
        if (
          typeof msg === "object" &&
          msg !== null &&
          "ready" in msg &&
          (msg as { ready: unknown }).ready === true &&
          !bridgeReady
        ) {
          bridgeReady = true;
          if (readyTimer) clearTimeout(readyTimer);
          resolveReady(msg as ReadyMessage);
          return;
        }
        const resp = msg as BridgeResponse;
        const reqId = resp.request_id;
        if (typeof reqId === "string") {
          const pendingReq = this.pending.get(reqId);
          if (pendingReq) {
            clearTimeout(pendingReq.timer);
            this.pending.delete(reqId);
            pendingReq.resolve(resp);
          } else {
            logger.warn({ request_id: reqId }, "[mempalace] orphan response");
          }
        } else {
          logger.warn(
            { line: raw.slice(0, 200) },
            "[mempalace] response with no request_id",
          );
        }
      };

      this.rl.on("line", (line) => {
        if (line) handleReadyLine(line);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          logger.error(
            { stderr: text.slice(0, 500) },
            "[mempalace bridge stderr]",
          );
        }
      });

      child.on("exit", (code, signal) => {
        logger.warn({ code, signal }, "[mempalace] bridge exited");
        if (this.proc === child) {
          this.proc = null;
          this.rl = null;
          this.readyPromise = null;
        }
        // §17.5 #2: reject all pending callers with structured error.
        for (const [, pendingReq] of this.pending) {
          clearTimeout(pendingReq.timer);
          pendingReq.reject(new ExternalError("bridge died"));
        }
        this.pending.clear();
        if (!bridgeReady) {
          if (readyTimer) clearTimeout(readyTimer);
          rejectReady(
            new ExternalError(
              `bridge exited before ready (code=${code} signal=${signal})`,
            ),
          );
        }
      });

      child.on("error", (err) => {
        if (!bridgeReady) {
          if (readyTimer) clearTimeout(readyTimer);
          this.readyPromise = null;
          rejectReady(err);
        }
      });

      // §17.5 #6: 10s readiness ceiling.
      readyTimer = setTimeout(() => {
        if (!bridgeReady) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
          this.readyPromise = null;
          rejectReady(
            new ExternalError(
              `bridge ready timeout (${this.opts.readyTimeoutMs}ms)`,
            ),
          );
        }
      }, this.opts.readyTimeoutMs);
    });

    return this.readyPromise;
  }

  async request<T extends BridgeResponse = BridgeResponse>(
    op: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    await this.start();
    if (!this.proc || !this.proc.stdin.writable) {
      throw new ExternalError("bridge stdin not writable");
    }
    const requestId = `r${++this.requestIdCounter}`;
    const req = { request_id: requestId, op, ...payload };
    return new Promise<T>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        rej(new ExternalError(`bridge timeout for op=${op} (${requestId})`));
      }, timeoutMs ?? this.opts.requestTimeoutMs);
      this.pending.set(requestId, {
        resolve: (r) => res(r as T),
        reject: rej,
        timer,
      });
      this.proc!.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  async ping(): Promise<PingResult> {
    const resp = await this.request("ping");
    if (!resp.ok || resp.pong !== true) {
      throw new ExternalError(`ping failed: ${resp.error ?? "unknown"}`);
    }
    return {
      pong: true,
      bridge_version: String(resp.bridge_version ?? "unknown"),
      mempalace_version:
        resp.mempalace_version === null || resp.mempalace_version === undefined
          ? null
          : String(resp.mempalace_version),
      mempalace_available: Boolean(resp.mempalace_available),
      mempalace_error:
        resp.mempalace_error === null || resp.mempalace_error === undefined
          ? null
          : String(resp.mempalace_error),
    };
  }

  close(): void {
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.stdin.end();
    } catch {
      // ignore
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 5000).unref();
    this.proc = null;
    this.rl = null;
    this.readyPromise = null;
  }

  get configuredScriptPath(): string {
    return this.opts.scriptPath;
  }

  get configuredPythonPath(): string {
    return this.opts.pythonPath;
  }
}

function defaultScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/memory/ → repo root → scripts/mempalace-bridge.py
  // (only TWO levels up: src/memory/ → src/ → repo root)
  return resolve(here, "..", "..", "scripts", "mempalace-bridge.py");
}
