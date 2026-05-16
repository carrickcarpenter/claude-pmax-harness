// Minimal Gmail wrapper — send + search. Search is the load-bearing
// op for the cron catch-up gmail-check (§17.3 #9 (c)).

import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string | null;
  internalDate?: string | null;
  /** Subject extracted from headers when available. */
  subject?: string;
  /** From: header. */
  from?: string;
}

/**
 * Search Gmail using the standard Gmail query syntax.
 * Returns up to `maxResults` matching messages with headers normalized.
 *
 * Example queries:
 *   `subject:"Morning Briefing" newer_than:1d`
 *   `from:me has:attachment newer_than:7d`
 */
export async function searchMessages(
  client: OAuth2Client,
  query: string,
  maxResults: number = 5,
): Promise<GmailMessage[]> {
  const gmail = google.gmail({ version: "v1", auth: client });
  const list = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults,
  });
  const messages = list.data.messages ?? [];
  const out: GmailMessage[] = [];
  for (const m of messages) {
    if (!m.id) continue;
    const full = await gmail.users.messages.get({
      userId: "me",
      id: m.id,
      format: "metadata",
      metadataHeaders: ["Subject", "From"],
    });
    const headers = full.data.payload?.headers ?? [];
    const subject = headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? undefined;
    const from = headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? undefined;
    out.push({
      id: m.id,
      threadId: m.threadId ?? "",
      snippet: full.data.snippet ?? null,
      internalDate: full.data.internalDate ?? null,
      subject,
      from,
    });
  }
  return out;
}

export interface SendMessageOptions {
  to: string;
  subject: string;
  body: string;
  /** From: header. If omitted, Gmail uses the authenticated user. */
  from?: string;
  cc?: string;
  bcc?: string;
  /** If true, body is treated as HTML. Default false (text/plain). */
  html?: boolean;
}

export async function sendMessage(
  client: OAuth2Client,
  opts: SendMessageOptions,
): Promise<{ id: string; threadId: string }> {
  const gmail = google.gmail({ version: "v1", auth: client });
  const raw = buildRfc822Message(opts);
  const encoded = Buffer.from(raw)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const resp = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded },
  });
  return {
    id: resp.data.id ?? "",
    threadId: resp.data.threadId ?? "",
  };
}

export function buildRfc822Message(opts: SendMessageOptions): string {
  const headers: string[] = [
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Content-Type: ${opts.html ? "text/html" : "text/plain"}; charset=utf-8`,
    `MIME-Version: 1.0`,
  ];
  if (opts.from) headers.push(`From: ${opts.from}`);
  if (opts.cc) headers.push(`Cc: ${opts.cc}`);
  if (opts.bcc) headers.push(`Bcc: ${opts.bcc}`);
  return headers.join("\r\n") + "\r\n\r\n" + opts.body;
}

/**
 * Helper for the cron catch-up triple-check (§17.3 #9 (c)): does a Gmail
 * message matching this subject from the authenticated user exist within
 * the last `newerThanDays` days?
 */
export async function wasSubjectSentRecently(
  client: OAuth2Client,
  subject: string,
  newerThanDays: number = 1,
): Promise<boolean> {
  // `from:me` matches messages sent by the authenticated user.
  // Subject quoting escapes embedded double-quotes per Gmail's query syntax.
  const safe = subject.replace(/"/g, '\\"');
  const q = `subject:"${safe}" newer_than:${newerThanDays}d from:me`;
  const found = await searchMessages(client, q, 1);
  return found.length > 0;
}
