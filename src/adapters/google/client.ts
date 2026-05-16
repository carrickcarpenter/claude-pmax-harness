// Authenticated Google OAuth2 client factory. Once OAuth has been completed
// via `harness google login`, this builds the OAuth2Client from .env values
// and refreshes the access token on demand. Other modules (gmail.ts,
// calendar.ts) accept a configured client.

import { OAuth2Client } from "google-auth-library";

export interface GoogleCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

export function makeOAuth2Client(creds: GoogleCredentials): OAuth2Client {
  const client = new OAuth2Client(creds.client_id, creds.client_secret);
  client.setCredentials({ refresh_token: creds.refresh_token });
  return client;
}

/**
 * Pull Google credentials from a process.env-shaped record. Returns null if
 * any of the three required GOOGLE_* vars are missing — callers should
 * surface a clear "google adapter not configured" error in that case.
 */
export function credentialsFromEnv(
  env: Record<string, string | undefined>,
): GoogleCredentials | null {
  const id = env.GOOGLE_CLIENT_ID;
  const secret = env.GOOGLE_CLIENT_SECRET;
  const token = env.GOOGLE_REFRESH_TOKEN;
  if (!id || !secret || !token) return null;
  return { client_id: id, client_secret: secret, refresh_token: token };
}
