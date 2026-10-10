export interface RateEvent {
  at: string;
  status: number;
  attempt: number;
  weight: number;
  duration_ms: number;
  limit: number | null;
  remaining: number | null;
  interval_ms: number | null;
  reset_ms: number | null;
  retry_after_ms: number | null;
  cooldown_ms: number;
  api_codes: number[];
}
const numeric = (headers: Headers, key: string) => {
  const raw = headers.get(key);
  return raw !== null && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null;
};
export function retryDelayMs(headers: Headers, attempt: number, now = Date.now()): number {
  const retry = headers.get("Retry-After");
  const standard =
    retry === null
      ? 0
      : /^\d+(?:\.\d+)?$/.test(retry)
        ? Number(retry) * 1000
        : Math.max(0, Date.parse(retry) - now) || 0;
  return Math.max(
    Math.min(1000 * 2 ** (attempt - 1), 8000),
    numeric(headers, "X-Lognex-Retry-After") ?? 0,
    numeric(headers, "X-Lognex-Reset") ?? 0,
    standard,
  );
}

/** One paced, FIFO queue shared by all operations in this process. No credentials or payloads are retained. */
export class RequestScheduler {
  private active = 0;
  private concurrency: number;
  private spacing: number;
  private nextStart = 0;
  private blockedUntil = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private queue: {
    weight: number;
    resolve: (release: () => void) => void;
    reject: (e: Error) => void;
    deadline: number;
  }[] = [];
  private events: RateEvent[] = [];
  private requests = 0;
  private throttled = 0;
  constructor(
    readonly budget = 8,
    concurrency = 2,
    readonly interval = 3000,
    readonly maxWait = 60000,
  ) {
    this.concurrency = Math.min(5, Math.max(1, concurrency));
    this.spacing = interval / Math.max(1, budget);
  }
  acquire(weight = 1): Promise<() => void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ weight: Math.max(1, weight), resolve, reject, deadline: Date.now() + this.maxWait });
      this.pump();
    });
  }
  private pump() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const now = Date.now();
    while (this.queue[0]?.deadline <= now)
      this.queue
        .shift()!
        .reject(
          new Error(
            "RATE_WAIT_EXHAUSTED: API cooldown exceeds waiting budget; retry later and use one server process.",
          ),
        );
    if (!this.queue.length) return;
    const ready = Math.max(this.nextStart, this.blockedUntil);
    if (this.active < this.concurrency && ready <= now) {
      const request = this.queue.shift()!;
      this.active++;
      this.requests++;
      this.nextStart = now + this.spacing * request.weight;
      let released = false;
      request.resolve(() => {
        if (!released) {
          released = true;
          this.active--;
          this.pump();
        }
      });
    }
    if (this.queue.length) {
      const wait =
        this.active < this.concurrency
          ? Math.min(
              Math.max(1, Math.max(this.nextStart, this.blockedUntil) - now),
              Math.max(1, this.queue[0].deadline - now),
            )
          : Math.max(1, this.queue[0].deadline - now);
      this.timer = setTimeout(() => this.pump(), wait);
    }
  }
  observe(status: number, headers: Headers, attempt: number, weight: number, duration: number, codes: number[] = []) {
    const now = Date.now();
    const limit = numeric(headers, "X-RateLimit-Limit"),
      interval = numeric(headers, "X-Lognex-Retry-TimeInterval");
    if (limit && interval) this.spacing = Math.max(this.spacing, interval / limit);
    let cooldown = 0;
    if (status === 429) {
      this.throttled++;
      cooldown = retryDelayMs(headers, attempt, now);
      if (codes.includes(1073)) this.concurrency = 1;
    } else if (numeric(headers, "X-RateLimit-Remaining") === 0) {
      cooldown =
        numeric(headers, "X-Lognex-Reset") ?? numeric(headers, "X-Lognex-Retry-After") ?? interval ?? this.interval;
    } else if (status >= 500) cooldown = retryDelayMs(headers, attempt, now);
    this.blockedUntil = Math.max(this.blockedUntil, now + cooldown);
    const event: RateEvent = {
      at: new Date(now).toISOString(),
      status,
      attempt,
      weight,
      duration_ms: duration,
      limit,
      remaining: numeric(headers, "X-RateLimit-Remaining"),
      interval_ms: interval,
      reset_ms: numeric(headers, "X-Lognex-Reset"),
      retry_after_ms: numeric(headers, "X-Lognex-Retry-After"),
      cooldown_ms: cooldown,
      api_codes: codes,
    };
    this.events.push(event);
    if (this.events.length > 100) this.events.shift();
    if (status === 429 || process.env.MOYSKLAD_DIAGNOSTICS === "1")
      console.error(JSON.stringify({ event: "moysklad_request", ...event }));
    this.pump();
  }
  diagnostics(last = 10) {
    return {
      requests: this.requests,
      throttled: this.throttled,
      queued: this.queue.length,
      active: this.active,
      configuration: {
        budget: this.budget,
        concurrency: this.concurrency,
        interval_ms: this.interval,
        pacing_ms_per_weight: this.spacing,
        max_wait_ms: this.maxWait,
      },
      cooldown_remaining_ms: Math.max(0, this.blockedUntil - Date.now()),
      events: last === 0 ? [] : this.events.slice(-last),
    };
  }
}
