// `harness google login` and `harness google test` per docs/architecture.md §3.

import { resolve } from "node:path";
import { loadConfig } from "../../config/load.js";
import { ConfigError, EXIT_CODES, UserError } from "../../lib/errors.js";
import {
  runOAuthLogin,
  persistGoogleCredentials,
} from "../../adapters/google/oauth.js";
import {
  credentialsFromEnv,
  makeOAuth2Client,
} from "../../adapters/google/client.js";
import { listUpcoming } from "../../adapters/google/calendar.js";
import { searchMessages } from "../../adapters/google/gmail.js";
import { logger } from "../../lib/logger.js";

export interface GoogleCommandOptions {
  projectRoot: string;
}

export async function runGoogleLogin(opts: GoogleCommandOptions): Promise<number> {
  // Pull client_id + client_secret from env. If not present, instruct the
  // user how to obtain them.
  let loaded;
  try {
    loaded = loadConfig({ projectRoot: opts.projectRoot });
  } catch (err) {
    if (err instanceof ConfigError) {
      // Config error during loading — env vars may still be in process.env.
      loaded = null;
    } else {
      throw err;
    }
  }
  const clientId = process.env.GOOGLE_CLIENT_ID ?? loaded?.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? loaded?.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new UserError(
      [
        "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env before running `harness google login`.",
        "",
        "Steps to obtain them:",
        "  1. Go to https://console.cloud.google.com/",
        "  2. Create (or pick) a project.",
        "  3. APIs & Services → Credentials → Create credentials → OAuth client ID.",
        "  4. Application type: Desktop app.",
        "  5. Add http://127.0.0.1 as an authorized redirect URI (the exact port is picked at runtime).",
        "  6. Copy the client ID + secret into .env as GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
        "  7. APIs & Services → Library → enable Gmail API, Google Calendar API, Google Drive API.",
        "  8. Re-run `harness google login`.",
      ].join("\n"),
    );
  }
  const scopes = loaded?.config?.google.scopes;
  const result = await runOAuthLogin({
    clientId,
    clientSecret,
    scopes: scopes && scopes.length > 0 ? scopes : undefined,
  });
  const envPath = resolve(opts.projectRoot, ".env");
  persistGoogleCredentials(envPath, {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: result.refreshToken,
  });
  console.log("Google login complete — refresh token saved to .env.");
  return EXIT_CODES.SUCCESS;
}

export async function runGoogleTest(opts: GoogleCommandOptions): Promise<number> {
  const loaded = loadConfig({ projectRoot: opts.projectRoot });
  const creds = credentialsFromEnv(process.env);
  if (!creds) {
    throw new UserError(
      "Google credentials not found in env. Run `harness google login` first.",
    );
  }
  const client = makeOAuth2Client(creds);
  console.log("Testing Google connectivity...");
  try {
    const events = await listUpcoming(client, { hours: 24, maxResults: 5 });
    console.log(`  ✓ Calendar: ${events.length} event(s) in next 24h`);
  } catch (err) {
    console.error(`  ✗ Calendar failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const recent = await searchMessages(client, "in:inbox newer_than:1d", 1);
    console.log(`  ✓ Gmail: ${recent.length > 0 ? "ok (1+ inbox message)" : "ok (no recent messages)"}`);
  } catch (err) {
    console.error(`  ✗ Gmail failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!loaded.config?.google.enabled) {
    console.log(
      "\nNote: google.enabled is false in personal/config.yaml. The bot + cron will not use Google " +
        "until you flip that flag (or re-run `harness setup` and pick yes on the Google prompt).",
    );
  }
  return EXIT_CODES.SUCCESS;
}
