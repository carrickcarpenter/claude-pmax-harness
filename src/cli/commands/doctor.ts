import { execSync } from "node:child_process";
import { existsSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { loadConfig, checkEnvFilePermissions } from "../../config/load.js";
import { ConfigError, EXIT_CODES } from "../../lib/errors.js";
import { MemPalaceBridge } from "../../memory/bridge.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
  fixHint?: string;
}

export interface DoctorOptions {
  projectRoot: string;
  fix?: boolean;
}

export async function runDoctor(opts: DoctorOptions): Promise<number> {
  const checks: CheckResult[] = [];

  checks.push(checkNode());
  checks.push(checkPython());
  checks.push(checkClaude());

  const envPath = resolve(opts.projectRoot, ".env");
  const envExists = existsSync(envPath);
  checks.push({
    name: ".env file present",
    ok: envExists,
    detail: envExists ? envPath : "missing",
    fixHint: envExists
      ? undefined
      : "copy .env.example to .env and fill in values",
  });

  if (envExists) {
    let perms = checkEnvFilePermissions(envPath);
    if (!perms.ok && opts.fix) {
      try {
        chmodSync(envPath, 0o600);
        perms = checkEnvFilePermissions(envPath);
      } catch {
        // ignore — perms object will still report failure
      }
    }
    checks.push({
      name: ".env permissions (600)",
      ok: perms.ok,
      detail: `mode ${perms.mode}${perms.warning ? ` — ${perms.warning}` : ""}`,
      fixHint: perms.ok
        ? undefined
        : opts.fix
          ? "tried to chmod 600 but it did not stick — investigate filesystem"
          : `run \`chmod 600 ${envPath}\` or re-run \`harness doctor --fix\``,
    });
  }

  try {
    const loaded = loadConfig({ projectRoot: opts.projectRoot });
    const setVars = Object.entries(loaded.env).filter(([, v]) => v).length;
    checks.push({
      name: "env vars valid",
      ok: true,
      detail: `${setVars} variable(s) set`,
    });
    checks.push({
      name: "personal/config.yaml",
      ok: loaded.config !== null,
      detail: loaded.config ? "loaded + validated" : "not yet generated",
      fixHint:
        loaded.config !== null
          ? undefined
          : "run `harness setup` to generate from templates",
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      checks.push({
        name: "config validation",
        ok: false,
        detail: firstLine(err.message),
        fixHint: "see error above — fix .env or personal/config.yaml then re-run",
      });
      console.error(`\n${err.message}\n`);
    } else {
      throw err;
    }
  }

  const dataDir =
    process.env.HARNESS_DATA_DIR ||
    resolve(homedir(), ".claude-pmax-harness");
  checks.push({
    name: "data dir path",
    ok: true,
    detail: `${dataDir}${existsSync(dataDir) ? " (exists)" : " (will be created at first run)"}`,
  });

  // §17.5 #1 — bridge ping. Two layered checks: bridge script can spawn +
  // ping (Python + bridge script work), and MemPalace package is installed
  // (the second is a WARN, not FAIL, because the user might be pre-install).
  const bridgeChecks = await checkBridge({ projectRoot: opts.projectRoot, dataDir });
  checks.push(...bridgeChecks);

  printReport(checks);

  const anyFailed = checks.some((c) => !c.ok);
  return anyFailed ? EXIT_CODES.CONFIG_ERROR : EXIT_CODES.SUCCESS;
}

function checkNode(): CheckResult {
  const major = parseInt(process.version.slice(1).split(".")[0] ?? "0", 10);
  return {
    name: "node >= 20",
    ok: major >= 20,
    detail: process.version,
    fixHint: major < 20 ? "upgrade Node to 20 or later" : undefined,
  };
}

function checkPython(): CheckResult {
  try {
    const out = execSync("python3 --version", {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    const match = out.match(/(\d+)\.(\d+)\.\d+/);
    if (!match) {
      return {
        name: "python3 >= 3.11",
        ok: false,
        detail: `unparseable: ${out}`,
      };
    }
    const major = parseInt(match[1] ?? "0", 10);
    const minor = parseInt(match[2] ?? "0", 10);
    const ok = major > 3 || (major === 3 && minor >= 11);
    return {
      name: "python3 >= 3.11",
      ok,
      detail: out,
      fixHint: ok ? undefined : "install Python 3.11 or later",
    };
  } catch {
    return {
      name: "python3 >= 3.11",
      ok: false,
      detail: "not found on PATH",
      fixHint: "install Python 3.11+ (needed for MemPalace bridge)",
    };
  }
}

function checkClaude(): CheckResult {
  const cliPath = process.env.CLAUDE_CLI || "claude";
  try {
    const out = execSync(`${cliPath} --version`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return { name: "claude CLI present", ok: true, detail: out };
  } catch {
    return {
      name: "claude CLI present",
      ok: false,
      detail: `\`${cliPath}\` not executable`,
      fixHint:
        "install Claude CLI (https://docs.claude.com/en/docs/claude-code) and ensure it is on PATH",
    };
  }
}

async function checkBridge(args: {
  projectRoot: string;
  dataDir: string;
}): Promise<CheckResult[]> {
  const scriptPath = resolve(args.projectRoot, "scripts", "mempalace-bridge.py");
  if (!existsSync(scriptPath)) {
    return [
      {
        name: "MemPalace bridge script",
        ok: false,
        detail: `not found at ${scriptPath}`,
        fixHint:
          "this should ship with the framework — repo install may be incomplete",
      },
    ];
  }

  const bridge = new MemPalaceBridge({
    scriptPath,
    dataDir: args.dataDir,
    readyTimeoutMs: 5000,
    requestTimeoutMs: 5000,
  });

  const out: CheckResult[] = [];
  try {
    const ready = await bridge.start();
    out.push({
      name: "MemPalace bridge ping",
      ok: true,
      detail: `bridge ${ready.bridge_version} on ${ready.python}`,
    });
    const pong = await bridge.ping();
    out.push({
      name: "MemPalace package installed",
      ok: pong.mempalace_available,
      detail: pong.mempalace_available
        ? `mempalace ${pong.mempalace_version ?? "unknown"}`
        : `not importable from ${bridge.configuredPythonPath} — ${pong.mempalace_error ?? "unknown error"}`,
      fixHint: pong.mempalace_available
        ? undefined
        : `run \`scripts/install-mempalace.sh\` to install into ${args.dataDir}/venv`,
    });
  } catch (err) {
    out.push({
      name: "MemPalace bridge ping",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      fixHint:
        "ensure python3 is on PATH and scripts/mempalace-bridge.py is intact",
    });
  } finally {
    bridge.close();
  }
  return out;
}

function firstLine(s: string): string {
  return s.split("\n")[0] ?? s;
}

function printReport(checks: CheckResult[]): void {
  const okCount = checks.filter((c) => c.ok).length;
  const total = checks.length;

  console.log("");
  console.log(`harness doctor — ${okCount}/${total} checks passed`);
  console.log("-".repeat(50));
  for (const c of checks) {
    const marker = c.ok ? "PASS" : "FAIL";
    console.log(`  [${marker}] ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
    if (!c.ok && c.fixHint) {
      console.log(`         -> ${c.fixHint}`);
    }
  }
  console.log("");
}
