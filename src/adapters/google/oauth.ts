// Google OAuth 2.0 flow for the harness's `google login` CLI command.
//
// Flow (since Google deprecated the oob/paste-code flow):
//   1. CLI generates an auth URL pointing at http://127.0.0.1:<port>/oauth/callback
//   2. CLI starts a temporary HTTP server on <port>
//   3. CLI prints the URL; user opens in their browser, completes consent
//   4. Google redirects to localhost; server captures `code`
//   5. CLI exchanges code for refresh_token via google-auth-library
//   6. CLI writes refresh_token + client_id + client_secret to .env
//   7. CLI shuts down server, prints success

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { OAuth2Client } from "google-auth-library";
import { logger } from "../../lib/logger.js";

export const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.readonly",
];

export interface OAuthLoginOptions {
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  /** Override the port — useful for tests. */
  port?: number;
  /** Override the host — defaults to 127.0.0.1 (localhost). */
  host?: string;
}

export interface OAuthLoginResult {
  refreshToken: string;
  accessToken?: string;
  scope?: string;
  tokenType?: string;
  expiryDate?: number | null;
}

export async function runOAuthLogin(opts: OAuthLoginOptions): Promise<OAuthLoginResult> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? (await pickFreePort());
  const redirectUri = `http://${host}:${port}/oauth/callback`;
  const scopes = opts.scopes ?? DEFAULT_SCOPES;

  const oauthClient = new OAuth2Client(opts.clientId, opts.clientSecret, redirectUri);
  const authUrl = oauthClient.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
  });

  const code = await captureCallbackCode({ host, port });
  console.log(`Open this URL in your browser to authorize:\n\n  ${authUrl}\n`);
  console.log("Waiting for the OAuth callback on the local port...");

  // captureCallbackCode is started first so the server is ready before we
  // print the URL. The promise resolves when the browser hits /oauth/callback.
  const captured = await code;
  if (captured.error) {
    throw new Error(`OAuth callback returned error: ${captured.error}`);
  }
  if (!captured.code) {
    throw new Error("OAuth callback did not include a `code` parameter");
  }

  const { tokens } = await oauthClient.getToken(captured.code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token. This usually means the account has already granted consent " +
        "to this client; visit https://myaccount.google.com/permissions and revoke access for this app, " +
        "then re-run `harness google login`.",
    );
  }
  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token ?? undefined,
    scope: tokens.scope ?? undefined,
    tokenType: tokens.token_type ?? undefined,
    expiryDate: tokens.expiry_date ?? null,
  };
}

interface CapturedCallback {
  code?: string;
  error?: string;
}

/**
 * Start an HTTP server that captures the OAuth callback. Returns a Promise
 * that resolves when the callback arrives OR rejects on timeout.
 * Exposed for tests via direct call with a stub redirect.
 */
export function captureCallbackCode(opts: {
  host: string;
  port: number;
  timeoutMs?: number;
}): Promise<CapturedCallback> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  return new Promise<CapturedCallback>((resolve, reject) => {
    let server: Server | null = null;
    const timer = setTimeout(() => {
      try {
        server?.close();
      } catch {
        // ignore
      }
      reject(new Error(`OAuth callback timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!req.url) {
        res.statusCode = 400;
        res.end("missing url");
        return;
      }
      const url = new URL(req.url, `http://${opts.host}:${opts.port}`);
      if (url.pathname !== "/oauth/callback") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const code = url.searchParams.get("code") ?? undefined;
      const error = url.searchParams.get("error") ?? undefined;
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><meta charset=utf-8><title>OAuth complete</title>` +
          `<body style="font-family:system-ui;padding:2rem">` +
          (error
            ? `<h1>OAuth error</h1><p><code>${escapeHtml(error)}</code></p>`
            : `<h1>OAuth complete</h1><p>You can close this tab and return to the terminal.</p>`) +
          `</body>`,
      );
      clearTimeout(timer);
      try {
        server?.close();
      } catch {
        // ignore
      }
      resolve({ code, error });
    });

    server.listen(opts.port, opts.host, () => {
      logger.info({ host: opts.host, port: opts.port }, "[oauth] callback listener ready");
    });
    server.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function pickFreePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not pick free port")));
      }
    });
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── .env writer ──────────────────────────────────────────────────────────

/**
 * Add or replace GOOGLE_* keys in the .env file, preserving everything else.
 * Sets chmod 600 (§14 secrets handling). Idempotent — re-running with the
 * same keys overwrites only those keys, leaves other lines untouched.
 */
export function persistGoogleCredentials(
  envPath: string,
  creds: { client_id: string; client_secret: string; refresh_token: string },
): void {
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const lines = existing.split("\n");
  const out: string[] = [];
  const seen = new Set<string>();
  const toSet: Record<string, string> = {
    GOOGLE_CLIENT_ID: creds.client_id,
    GOOGLE_CLIENT_SECRET: creds.client_secret,
    GOOGLE_REFRESH_TOKEN: creds.refresh_token,
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      out.push(line);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (key in toSet) {
      out.push(`${key}=${toSet[key]}`);
      seen.add(key);
    } else {
      out.push(line);
    }
  }
  // Append keys that weren't already present.
  for (const [k, v] of Object.entries(toSet)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  writeFileSync(envPath, out.join("\n").trimEnd() + "\n");
  try {
    chmodSync(envPath, 0o600);
  } catch {
    // best-effort
  }
}
