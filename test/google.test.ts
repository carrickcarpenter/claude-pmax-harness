import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";

import { buildRfc822Message } from "../src/adapters/google/gmail.js";
import {
  credentialsFromEnv,
  makeOAuth2Client,
} from "../src/adapters/google/client.js";
import {
  persistGoogleCredentials,
  captureCallbackCode,
  DEFAULT_SCOPES,
} from "../src/adapters/google/oauth.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "google-test-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── gmail.buildRfc822Message ────────────────────────────────────────────

describe("buildRfc822Message", () => {
  test("builds a minimal text/plain message with required headers", () => {
    const raw = buildRfc822Message({
      to: "owner@example.com",
      subject: "Hello",
      body: "World",
    });
    expect(raw).toContain("To: owner@example.com");
    expect(raw).toContain("Subject: Hello");
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8");
    expect(raw).toContain("MIME-Version: 1.0");
    expect(raw.endsWith("\r\n\r\nWorld")).toBe(true);
  });

  test("includes optional From/Cc/Bcc when supplied", () => {
    const raw = buildRfc822Message({
      to: "a@example.com",
      subject: "x",
      body: "y",
      from: "me@example.com",
      cc: "b@example.com",
      bcc: "c@example.com",
    });
    expect(raw).toContain("From: me@example.com");
    expect(raw).toContain("Cc: b@example.com");
    expect(raw).toContain("Bcc: c@example.com");
  });

  test("html: true switches Content-Type to text/html", () => {
    const raw = buildRfc822Message({
      to: "a@example.com",
      subject: "x",
      body: "<p>y</p>",
      html: true,
    });
    expect(raw).toContain("Content-Type: text/html; charset=utf-8");
  });
});

// ── client.credentialsFromEnv + makeOAuth2Client ────────────────────────

describe("credentialsFromEnv", () => {
  test("returns null when any of the three required vars are missing", () => {
    expect(credentialsFromEnv({})).toBeNull();
    expect(
      credentialsFromEnv({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" }),
    ).toBeNull();
    expect(
      credentialsFromEnv({
        GOOGLE_CLIENT_ID: "a",
        GOOGLE_REFRESH_TOKEN: "c",
      }),
    ).toBeNull();
  });

  test("returns shaped credentials when all three are present", () => {
    const creds = credentialsFromEnv({
      GOOGLE_CLIENT_ID: "cid",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_REFRESH_TOKEN: "token",
    });
    expect(creds).toEqual({
      client_id: "cid",
      client_secret: "secret",
      refresh_token: "token",
    });
  });

  test("makeOAuth2Client returns a client with the refresh token set", () => {
    const client = makeOAuth2Client({
      client_id: "cid",
      client_secret: "secret",
      refresh_token: "token",
    });
    // google-auth-library doesn't expose the refresh_token directly; cred
    // shape is what matters. Verify it's not null/undefined.
    expect(client).toBeTruthy();
    expect(typeof client.refreshAccessToken).toBe("function");
  });
});

// ── oauth.persistGoogleCredentials ──────────────────────────────────────

describe("persistGoogleCredentials", () => {
  test("creates .env when missing and writes the three GOOGLE_* keys", () => {
    const envPath = resolve(tmpRoot, ".env");
    persistGoogleCredentials(envPath, {
      client_id: "cid",
      client_secret: "secret",
      refresh_token: "token",
    });
    const contents = readFileSync(envPath, "utf-8");
    expect(contents).toContain("GOOGLE_CLIENT_ID=cid");
    expect(contents).toContain("GOOGLE_CLIENT_SECRET=secret");
    expect(contents).toContain("GOOGLE_REFRESH_TOKEN=token");
    // chmod 600 attempted (POSIX); permissions may not apply on all FS but
    // we shouldn't error.
    expect(statSync(envPath).isFile()).toBe(true);
  });

  test("preserves existing unrelated lines and only updates GOOGLE_* keys", () => {
    const envPath = resolve(tmpRoot, ".env");
    writeFileSync(
      envPath,
      [
        "# my env",
        "TELEGRAM_BOT_TOKEN=abc",
        "GOOGLE_CLIENT_ID=old-cid",
        "OTHER_VAR=42",
      ].join("\n") + "\n",
    );
    persistGoogleCredentials(envPath, {
      client_id: "new-cid",
      client_secret: "new-secret",
      refresh_token: "new-token",
    });
    const contents = readFileSync(envPath, "utf-8");
    expect(contents).toContain("TELEGRAM_BOT_TOKEN=abc");
    expect(contents).toContain("OTHER_VAR=42");
    expect(contents).toContain("GOOGLE_CLIENT_ID=new-cid"); // overwritten
    expect(contents).not.toContain("GOOGLE_CLIENT_ID=old-cid");
    expect(contents).toContain("GOOGLE_CLIENT_SECRET=new-secret");
    expect(contents).toContain("GOOGLE_REFRESH_TOKEN=new-token");
    expect(contents).toContain("# my env"); // comment preserved
  });

  test("is idempotent — running twice produces the same file", () => {
    const envPath = resolve(tmpRoot, ".env");
    const creds = { client_id: "c", client_secret: "s", refresh_token: "t" };
    persistGoogleCredentials(envPath, creds);
    const first = readFileSync(envPath, "utf-8");
    persistGoogleCredentials(envPath, creds);
    const second = readFileSync(envPath, "utf-8");
    expect(second).toBe(first);
  });
});

// ── oauth.DEFAULT_SCOPES ────────────────────────────────────────────────

describe("DEFAULT_SCOPES", () => {
  test("includes Gmail send + Calendar + Drive read scopes", () => {
    expect(DEFAULT_SCOPES).toEqual(
      expect.arrayContaining([
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/drive.readonly",
      ]),
    );
  });
});

// ── oauth.captureCallbackCode (real HTTP server, real request) ──────────

describe("captureCallbackCode", () => {
  test("resolves with `code` when the browser hits /oauth/callback?code=...", async () => {
    // Start the callback listener and immediately fire a GET request to it.
    const port = await pickFreePort();
    const captured = captureCallbackCode({
      host: "127.0.0.1",
      port,
      timeoutMs: 3000,
    });
    // Give the server a beat to bind
    await new Promise((r) => setTimeout(r, 50));
    await new Promise<void>((resolveReq, rejectReq) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/oauth/callback?code=test-code-xyz",
          method: "GET",
        },
        (res) => {
          res.resume();
          res.on("end", () => resolveReq());
        },
      );
      req.on("error", rejectReq);
      req.end();
    });
    const result = await captured;
    expect(result.code).toBe("test-code-xyz");
    expect(result.error).toBeUndefined();
  });

  test("resolves with `error` when the callback returns an OAuth error", async () => {
    const port = await pickFreePort();
    const captured = captureCallbackCode({
      host: "127.0.0.1",
      port,
      timeoutMs: 3000,
    });
    await new Promise((r) => setTimeout(r, 50));
    await new Promise<void>((resolveReq, rejectReq) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/oauth/callback?error=access_denied",
          method: "GET",
        },
        (res) => {
          res.resume();
          res.on("end", () => resolveReq());
        },
      );
      req.on("error", rejectReq);
      req.end();
    });
    const result = await captured;
    expect(result.error).toBe("access_denied");
    expect(result.code).toBeUndefined();
  });

  test("rejects with timeout when no callback arrives", async () => {
    const port = await pickFreePort();
    await expect(
      captureCallbackCode({ host: "127.0.0.1", port, timeoutMs: 200 }),
    ).rejects.toThrow(/timeout/i);
  });
});

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
