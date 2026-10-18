export interface PollOpts {
  readonly timeoutMs: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly what: string;
}

export const DEFAULT_INITIAL_DELAY_MS = 2_000;
export const DEFAULT_MAX_DELAY_MS = 5_000;

export function backoffDelayMs(
  attempt: number,
  initialDelayMs: number = DEFAULT_INITIAL_DELAY_MS,
  maxDelayMs: number = DEFAULT_MAX_DELAY_MS,
): number {
  return Math.min(initialDelayMs + attempt * 1_000, maxDelayMs);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PollTimeout extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for ${what}`);
    this.name = "PollTimeout";
  }
}

export class UnrecognisedShape extends Error {
  constructor(what: string, saw: string) {
    super(`${what}: the response is in a shape this gate does not recognise — saw ${saw}`);
    this.name = "UnrecognisedShape";
  }
}

export async function pollUntil<T>(probe: () => Promise<T | undefined>, opts: PollOpts): Promise<T> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const found = await probe();
    if (found !== undefined) return found;
    const elapsed = Date.now() - started;
    if (elapsed >= opts.timeoutMs) throw new PollTimeout(opts.what, opts.timeoutMs);
    const delay = Math.min(
      backoffDelayMs(attempt, opts.initialDelayMs, opts.maxDelayMs),
      opts.timeoutMs - elapsed,
    );
    await sleep(delay);
  }
}

export async function pollOptional<T>(probe: () => Promise<T | undefined>, opts: PollOpts): Promise<T | undefined> {
  let lastError: unknown;
  let lastAttemptThrew = false;
  const tolerant = async (): Promise<T | undefined> => {
    try {
      const found = await probe();
      lastAttemptThrew = false;
      return found;
    } catch (err) {
      if (err instanceof UnrecognisedShape) throw err;
      if (lastAttemptThrew) throw err;
      lastAttemptThrew = true;
      lastError = err;
      return undefined;
    }
  };
  try {
    return await pollUntil(tolerant, opts);
  } catch (err) {
    if (!(err instanceof PollTimeout)) throw err;
    if (lastAttemptThrew) throw lastError;
    return undefined;
  }
}
