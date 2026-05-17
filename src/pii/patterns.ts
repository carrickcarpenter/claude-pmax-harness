// PII category patterns per docs/architecture.md §18.1 + PLAN.md
// "PII patterns to teach users".
//
// IMPORTANT: scanner reports the *count* per category and the *line numbers*
// where matches occurred. It does NOT report the matched values themselves —
// see scanner.ts. This is the §18.1 design: tell the user what categories of
// risk are present, not surface the secrets themselves.

export type PiiCategory =
  | "email"
  | "phone"
  | "address"
  | "calendar_id"
  | "financial";

// Email: standard RFC-ish shape. Excludes obvious test values (example.com,
// localhost) via post-match filter (in scanner.ts), not in the regex itself.
const EMAIL = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;

// Phone: US/Canada-leaning patterns + simple international forms.
// Three groups of digits separated by -.space (or parens around the first
// three). At least ONE of the two interior separators must be present —
// otherwise the regex would match any 10-digit chunk (bot tokens, IDs,
// timestamps), producing many false positives. Real phone numbers in
// the wild almost always have separators.
const PHONE = /(?:\+\d{1,3}[-.\s]?)?(?:\(\d{3}\)\s*|\d{3}[-.\s])\d{3}[-.\s]?\d{4}\b|(?:\+\d{1,3}[-.\s]?)?\d{3}[-.\s]?\d{3}[-.\s]\d{4}\b/g;

// US street address heuristic: <number> <2+ words> <street-suffix>
// Catches "123 Main St", "4567 Oak Avenue", "1 First Ave", etc.
const ADDRESS =
  /\b\d{1,6}\s+(?:[A-Z][a-zA-Z]+\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Way|Terrace|Ter|Circle|Cir|Highway|Hwy|Parkway|Pkwy)\b\.?/g;

// Google Calendar IDs: ...@group.calendar.google.com
const CALENDAR_ID = /\b[a-z0-9]{6,}@group\.calendar\.google\.com\b/g;

// Financial: SSN-like (###-##-####), credit-card-like (#### #### #### ####)
const FINANCIAL_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}\b/g,
];

// Generic placeholder allowlist — values that look PII-shaped but are
// universally understood as fakes.
export const PLACEHOLDER_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "localhost",
  "test.com",
  "fake.com",
]);

export const PLACEHOLDER_EMAILS = new Set([
  "test@example.com",
  "user@example.com",
  "owner@example.com",
  "you@example.com",
  "name@example.com",
  "email@example.com",
]);

export interface CategoryConfig {
  category: PiiCategory;
  /** Returns the array of match strings found in the input text. */
  find(text: string): string[];
}

export const CATEGORIES: Record<PiiCategory, CategoryConfig> = {
  email: {
    category: "email",
    find(text) {
      const matches = text.match(EMAIL) ?? [];
      return matches.filter((m) => !isAllowlistedEmail(m));
    },
  },
  phone: {
    category: "phone",
    find(text) {
      return text.match(PHONE) ?? [];
    },
  },
  address: {
    category: "address",
    find(text) {
      return text.match(ADDRESS) ?? [];
    },
  },
  calendar_id: {
    category: "calendar_id",
    find(text) {
      return text.match(CALENDAR_ID) ?? [];
    },
  },
  financial: {
    category: "financial",
    find(text) {
      const out: string[] = [];
      for (const p of FINANCIAL_PATTERNS) {
        const matches = text.match(p) ?? [];
        out.push(...matches);
      }
      return out;
    },
  },
};

function isAllowlistedEmail(match: string): boolean {
  if (PLACEHOLDER_EMAILS.has(match.toLowerCase())) return true;
  const at = match.lastIndexOf("@");
  if (at < 0) return false;
  const domain = match.slice(at + 1).toLowerCase();
  return PLACEHOLDER_DOMAINS.has(domain);
}
