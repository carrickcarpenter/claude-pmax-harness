import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";
import * as dotenv from "dotenv";
import { ConfigSchema, EnvSchema, type Config, type Env } from "./schema.js";
import { ConfigError } from "../lib/errors.js";

export interface LoadedConfig {
  config: Config | null;
  env: Env;
  configPath: string;
  envPath: string;
}

export interface LoadOptions {
  projectRoot: string;
}

export function loadConfig(opts: LoadOptions): LoadedConfig {
  const envPath = resolve(opts.projectRoot, ".env");
  const configPath = resolve(opts.projectRoot, "personal", "config.yaml");

  if (existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }

  const envResult = EnvSchema.safeParse(process.env);
  if (!envResult.success) {
    const issues = envResult.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(
      `Invalid or missing environment variables (set in ${envPath}):\n${issues}`,
    );
  }

  let config: Config | null = null;
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (err) {
      throw new ConfigError(
        `Could not parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      throw new ConfigError(`Invalid config in ${configPath}:\n${issues}`);
    }
    config = result.data;
  }

  return {
    config,
    env: envResult.data,
    configPath,
    envPath,
  };
}

export function checkEnvFilePermissions(envPath: string): {
  ok: boolean;
  mode: string;
  warning?: string;
} {
  if (!existsSync(envPath)) {
    return { ok: true, mode: "n/a" };
  }
  const stat = statSync(envPath);
  const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
  if (mode !== "600") {
    return {
      ok: false,
      mode,
      warning: `expected 600 (owner-only), got ${mode} — secrets may be readable by others`,
    };
  }
  return { ok: true, mode };
}
