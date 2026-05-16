// Minimal Calendar wrapper — list upcoming events + create event.
// Drive support deferred to step 9b per the §16 step-9 scope notes.

import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export interface CalendarEvent {
  id: string;
  summary?: string;
  start?: string;
  end?: string;
  location?: string;
  description?: string;
  attendees?: Array<{ email?: string; responseStatus?: string }>;
}

export interface ListUpcomingOptions {
  /** Calendar ID — default "primary". */
  calendarId?: string;
  /** Look-ahead window in hours. Default 24. */
  hours?: number;
  /** Cap on returned events. Default 20. */
  maxResults?: number;
}

export async function listUpcoming(
  client: OAuth2Client,
  opts: ListUpcomingOptions = {},
): Promise<CalendarEvent[]> {
  const calendar = google.calendar({ version: "v3", auth: client });
  const now = new Date();
  const horizon = new Date(now.getTime() + (opts.hours ?? 24) * 60 * 60 * 1000);
  const resp = await calendar.events.list({
    calendarId: opts.calendarId ?? "primary",
    timeMin: now.toISOString(),
    timeMax: horizon.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: opts.maxResults ?? 20,
  });
  const items = resp.data.items ?? [];
  return items.map((e) => ({
    id: e.id ?? "",
    summary: e.summary ?? undefined,
    start: e.start?.dateTime ?? e.start?.date ?? undefined,
    end: e.end?.dateTime ?? e.end?.date ?? undefined,
    location: e.location ?? undefined,
    description: e.description ?? undefined,
    attendees: (e.attendees ?? []).map((a) => ({
      email: a.email ?? undefined,
      responseStatus: a.responseStatus ?? undefined,
    })),
  }));
}

export interface CreateEventOptions {
  calendarId?: string;
  summary: string;
  /** ISO 8601 datetime with timezone offset. */
  start: string;
  /** ISO 8601 datetime with timezone offset. */
  end: string;
  description?: string;
  location?: string;
  attendees?: string[];
}

export async function createEvent(
  client: OAuth2Client,
  opts: CreateEventOptions,
): Promise<{ id: string; htmlLink?: string }> {
  const calendar = google.calendar({ version: "v3", auth: client });
  const resp = await calendar.events.insert({
    calendarId: opts.calendarId ?? "primary",
    requestBody: {
      summary: opts.summary,
      start: { dateTime: opts.start },
      end: { dateTime: opts.end },
      description: opts.description,
      location: opts.location,
      attendees: opts.attendees?.map((email) => ({ email })),
    },
  });
  return {
    id: resp.data.id ?? "",
    htmlLink: resp.data.htmlLink ?? undefined,
  };
}
