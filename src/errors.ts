export class DdserveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DdserveError";
  }
}

export class HttpError extends DdserveError {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HttpError";
  }
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
