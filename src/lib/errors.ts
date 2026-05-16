// Typed errors with exit codes per docs/architecture.md §3:
// 0 success, 1 user error, 2 config error, 3 external service error, 4 internal error.

export const EXIT_CODES = {
  SUCCESS: 0,
  USER_ERROR: 1,
  CONFIG_ERROR: 2,
  EXTERNAL_ERROR: 3,
  INTERNAL_ERROR: 4,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export class HarnessError extends Error {
  constructor(
    message: string,
    public readonly exitCode: ExitCode = EXIT_CODES.INTERNAL_ERROR,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class UserError extends HarnessError {
  constructor(message: string) {
    super(message, EXIT_CODES.USER_ERROR);
  }
}

export class ConfigError extends HarnessError {
  constructor(message: string) {
    super(message, EXIT_CODES.CONFIG_ERROR);
  }
}

export class ExternalError extends HarnessError {
  constructor(message: string) {
    super(message, EXIT_CODES.EXTERNAL_ERROR);
  }
}
