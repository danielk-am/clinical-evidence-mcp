export class InputError extends Error {
  override readonly name = "InputError";
}

export class UpstreamError extends Error {
  override readonly name = "UpstreamError";

  constructor(
    readonly source: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof InputError || error instanceof UpstreamError) {
    return error.message;
  }
  return "Request failed. Check server logs with request-body logging disabled.";
}
