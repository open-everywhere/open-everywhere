export class EventDedupe {
  private readonly seenAt = new Map<string, number>();
  constructor(private readonly ttlMs = 10 * 60_000, private readonly max = 5_000) {}

  seen(key: string, nowMs: number = Date.now()): boolean {
    const at = this.seenAt.get(key);
    if (at === undefined) return false;
    if (nowMs - at > this.ttlMs) {
      this.seenAt.delete(key);
      return false;
    }
    return true;
  }

  mark(key: string, nowMs: number = Date.now()): void {
    this.seenAt.set(key, nowMs);
    if (this.seenAt.size > this.max) this.prune(nowMs);
  }

  private prune(nowMs: number): void {
    for (const [k, t] of this.seenAt) if (nowMs - t > this.ttlMs) this.seenAt.delete(k);
    if (this.seenAt.size > this.max) {
      const drop = this.seenAt.size - this.max;
      let i = 0;
      for (const k of this.seenAt.keys()) {
        if (i++ >= drop) break;
        this.seenAt.delete(k);
      }
    }
  }
}

export class ThreadFifo {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly onFailure?: (key: string, err: unknown) => void) {}

  enqueue(key: string, run: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => run())
      .catch((err) => {
        console.warn(`[open-everywhere:front-queue] wake delivery failed (${key}): ${String(err)}`);
        try {
          this.onFailure?.(key, err);
        } catch {
        }
      });
    this.tails.set(key, next);
    void next.finally(() => {
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    return next;
  }

  get activeThreads(): number {
    return this.tails.size;
  }
}
