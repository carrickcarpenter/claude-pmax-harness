// Error-shape detection per docs/architecture.md §17.2 #4.
//
// Claude CLI exit codes don't always reflect content failure. The CLI can
// "succeed" (exit 0) while emitting a response that's an apology or an API
// error string. Treat those as failures so the cron runner's retry logic
// engages and the chat path doesn't ship gibberish to the user.
//
// Pattern set adapted from the sibling reference codebase and intended to
// be refreshed by reviewing pmax-cli-expert findings when Claude behavior
// or error formatting changes upstream.

export const ERROR_RESPONSE_PATTERNS: RegExp[] = [
  /sorry.*hit an error/i,
  /i['']ll be back shortly/i,
  /something went wrong/i,
  /i encountered an? (?:error|issue|problem)/i,
  /i['']m having (?:trouble|difficulty|issues)/i,
  /unable to (?:process|complete|respond)/i,
];

// API-error-shaped result text — Claude CLI can emit these as its result
// even on exit 0. Catches overloaded, rate-limited, and invalid-request
// failures that came back as plain text.
export const API_ERROR_PATTERNS: RegExp[] = [
  /^API Error:/i,
  /"type"\s*:\s*"error"[\s\S]*"(overloaded_error|rate_limit_error|api_error|invalid_request_error)"/,
];

export interface ErrorShapeMatch {
  flagged: boolean;
  reason?: string;
  category?: "soft-apology" | "api-error";
}

export function classifyResponse(text: string): ErrorShapeMatch {
  // Check the first 500 chars for an API-error shape — those usually appear at
  // the start of the result text.
  const head = text.slice(0, 500);
  for (const pattern of API_ERROR_PATTERNS) {
    if (pattern.test(head)) {
      return {
        flagged: true,
        category: "api-error",
        reason: `API-error shape detected in result head: ${pattern.source}`,
      };
    }
  }
  for (const pattern of ERROR_RESPONSE_PATTERNS) {
    if (pattern.test(text)) {
      return {
        flagged: true,
        category: "soft-apology",
        reason: `Error-like response pattern matched: ${pattern.source}`,
      };
    }
  }
  return { flagged: false };
}
