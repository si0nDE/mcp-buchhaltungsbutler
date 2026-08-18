export class BuchhaltungsButlerApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly endpoint: string,
    public readonly responseBody: unknown
  ) {
    super(message);
    this.name = "BuchhaltungsButlerApiError";
  }
}

export class BuchhaltungsButlerRateLimitError extends BuchhaltungsButlerApiError {
  constructor(endpoint: string, responseBody: unknown) {
    super(
      `BuchhaltungsButler API rate limit exceeded on ${endpoint} (max 100 requests/min per customer)`,
      429,
      endpoint,
      responseBody
    );
    this.name = "BuchhaltungsButlerRateLimitError";
  }
}
