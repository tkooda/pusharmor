// ApiError is the only way a handler fails a request. status + catalog error word.
export class ApiError extends Error {
  readonly status: number;
  readonly word: string;
  readonly extra: Record<string, unknown> | undefined;
  constructor(status: number, word: string, extra?: Record<string, unknown>) {
    super(word);
    this.status = status;
    this.word = word;
    this.extra = extra;
  }
}

export const RETRY_AFTER_S = 60;

export function rateLimited(binding: string): ApiError {
  return new ApiError(429, "rate limited", { retry_after: RETRY_AFTER_S, _binding: binding });
}
