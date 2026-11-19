export type ErrorCode = "USAGE" | "CONFIG" | "AUTH" | "API" | "NOT_FOUND";

export const EXIT_CODES: Record<ErrorCode, number> = {
  USAGE: 1,
  CONFIG: 1,
  AUTH: 2,
  API: 2,
  NOT_FOUND: 3,
};

export class AdoError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status?: number,
    public hint?: string,
  ) {
    super(message);
    this.name = "AdoError";
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.status !== undefined ? { status: this.status } : {}),
        ...(this.hint ? { hint: this.hint } : {}),
      },
    };
  }
}
