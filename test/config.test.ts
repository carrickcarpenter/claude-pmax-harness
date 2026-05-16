import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, checkEnvFilePermissions } from "../src/config/load.js";
import { ConfigError } from "../src/lib/errors.js";

let tmpRoot: string;
let originalEnv: NodeJS.ProcessEnv;

const ENV_KEYS_TO_ISOLATE = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_OWNER_CHAT_ID",
  "HARNESS_DATA_DIR",
  "HARNESS_LOG_LEVEL",
  "CLAUDE_CLI",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
];

beforeEach(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "harness-test-"));
  originalEnv = { ...process.env };
  for (const key of ENV_KEYS_TO_ISOLATE) {
    delete process.env[key];
  }
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  process.env = originalEnv;
});

describe("loadConfig", () => {
  test("throws ConfigError when required env vars are missing and no .env file exists", () => {
    expect(() => loadConfig({ projectRoot: tmpRoot })).toThrow(ConfigError);
  });

  test("loads env successfully when required vars are set in .env", () => {
    writeFileSync(
      resolve(tmpRoot, ".env"),
      `TELEGRAM_BOT_TOKEN=test_token_123\nTELEGRAM_OWNER_CHAT_ID=999\n`,
    );
    const loaded = loadConfig({ projectRoot: tmpRoot });
    expect(loaded.env.TELEGRAM_BOT_TOKEN).toBe("test_token_123");
    expect(loaded.env.TELEGRAM_OWNER_CHAT_ID).toBe("999");
    expect(loaded.config).toBeNull();
  });

  test("loads personal/config.yaml when present and valid, applies defaults", () => {
    writeFileSync(
      resolve(tmpRoot, ".env"),
      `TELEGRAM_BOT_TOKEN=t\nTELEGRAM_OWNER_CHAT_ID=1\n`,
    );
    mkdirSync(resolve(tmpRoot, "personal"));
    writeFileSync(
      resolve(tmpRoot, "personal", "config.yaml"),
      `owner:\n  name: TestUser\n  timezone: America/New_York\n`,
    );
    const loaded = loadConfig({ projectRoot: tmpRoot });
    expect(loaded.config?.owner.name).toBe("TestUser");
    expect(loaded.config?.owner.timezone).toBe("America/New_York");
    expect(loaded.config?.tools.allow_dangerous).toBe(true);
    expect(loaded.config?.cron.tick_interval_ms).toBe(30_000);
    expect(loaded.config?.memory.mempalace.write_mode).toBe("sync");
    expect(loaded.config?.bot.watchdog.max_failures).toBe(3);
  });

  test("rejects invalid IANA timezone", () => {
    writeFileSync(
      resolve(tmpRoot, ".env"),
      `TELEGRAM_BOT_TOKEN=t\nTELEGRAM_OWNER_CHAT_ID=1\n`,
    );
    mkdirSync(resolve(tmpRoot, "personal"));
    writeFileSync(
      resolve(tmpRoot, "personal", "config.yaml"),
      `owner:\n  name: U\n  timezone: Not/A/Real/TZ\n`,
    );
    expect(() => loadConfig({ projectRoot: tmpRoot })).toThrow(/timezone/);
  });

  test("rejects out-of-range time-of-day in quiet_hours", () => {
    writeFileSync(
      resolve(tmpRoot, ".env"),
      `TELEGRAM_BOT_TOKEN=t\nTELEGRAM_OWNER_CHAT_ID=1\n`,
    );
    mkdirSync(resolve(tmpRoot, "personal"));
    writeFileSync(
      resolve(tmpRoot, "personal", "config.yaml"),
      [
        `owner:`,
        `  name: U`,
        `  timezone: America/New_York`,
        `assistant:`,
        `  heartbeat:`,
        `    quiet_hours: { start: "25:00", end: "07:00" }`,
      ].join("\n"),
    );
    expect(() => loadConfig({ projectRoot: tmpRoot })).toThrow(/HH:MM/);
  });

  test("throws ConfigError on malformed YAML", () => {
    writeFileSync(
      resolve(tmpRoot, ".env"),
      `TELEGRAM_BOT_TOKEN=t\nTELEGRAM_OWNER_CHAT_ID=1\n`,
    );
    mkdirSync(resolve(tmpRoot, "personal"));
    writeFileSync(
      resolve(tmpRoot, "personal", "config.yaml"),
      `owner:\n  name: [unclosed\n`,
    );
    expect(() => loadConfig({ projectRoot: tmpRoot })).toThrow(ConfigError);
  });
});

describe("checkEnvFilePermissions", () => {
  test("returns ok for missing .env (nothing to check)", () => {
    const result = checkEnvFilePermissions(resolve(tmpRoot, ".env"));
    expect(result.ok).toBe(true);
  });

  test("returns ok for mode 600", () => {
    const envPath = resolve(tmpRoot, ".env");
    writeFileSync(envPath, "X=y\n");
    chmodSync(envPath, 0o600);
    const result = checkEnvFilePermissions(envPath);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("600");
  });

  test("returns not-ok with warning for mode 644", () => {
    const envPath = resolve(tmpRoot, ".env");
    writeFileSync(envPath, "X=y\n");
    chmodSync(envPath, 0o644);
    const result = checkEnvFilePermissions(envPath);
    expect(result.ok).toBe(false);
    expect(result.mode).toBe("644");
    expect(result.warning).toContain("expected 600");
  });
});
