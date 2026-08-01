import { InputError } from "./errors.js";

export class AccountRateLimiter {
  private readonly requests = new Map<string, number[]>();

  constructor(private readonly maximumPerMinute: number) {}

  consume(accountId: string, now = Date.now()): void {
    const cutoff = now - 60_000;
    const recent = (this.requests.get(accountId) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= this.maximumPerMinute) {
      throw new InputError("Request limit reached. Try again in one minute.");
    }
    recent.push(now);
    this.requests.set(accountId, recent);
  }
}
