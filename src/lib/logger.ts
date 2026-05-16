import pino from "pino";

// Structured logger per docs/architecture.md §14 "Observability and logging".
// All logs go to stderr; data goes to stdout (CLI convention).

const level = process.env.HARNESS_LOG_LEVEL || "info";

export const logger = pino({
  level,
  base: undefined,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

export type Logger = typeof logger;
