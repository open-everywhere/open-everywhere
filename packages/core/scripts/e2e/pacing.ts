import { PACING_CHANNEL_FLOOR_MS, PACING_MAX_CONCURRENT_PER_SURFACE } from "./env.js";

export interface PacingClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const SYSTEM_PACING_CLOCK: PacingClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface PacingStats {
  readonly drivesPerChannel: ReadonlyMap<string, number>;
  readonly maxConcurrencyPerSurface: ReadonlyMap<string, number>;
  readonly waitedMs: number;
  readonly totalDrives: number;
}

export interface PacingGate {
  drive<T>(surface: string, channel: string, fn: () => Promise<T>): Promise<T>;
  driveBurst<T>(surface: string, channels: readonly string[], fn: () => Promise<T>): Promise<T>;
  stats(): PacingStats;
}

function channelKey(surface: string, channel: string): string {
  return `${surface}/${channel}`;
}

export function createPacingGate(opts?: {
  readonly floorMs?: number;
  readonly maxConcurrentPerSurface?: number;
  readonly clock?: PacingClock;
}): PacingGate {
  const floorMs = opts?.floorMs ?? PACING_CHANNEL_FLOOR_MS;
  const cap = opts?.maxConcurrentPerSurface ?? PACING_MAX_CONCURRENT_PER_SURFACE;
  const clock = opts?.clock ?? SYSTEM_PACING_CLOCK;

  const nextAllowedAt = new Map<string, number>();
  const drivesPerChannel = new Map<string, number>();
  const inFlight = new Map<string, number>();
  const maxConcurrencyPerSurface = new Map<string, number>();
  const waiters = new Map<string, { need: number; resolve: () => void }[]>();
  let waitedMs = 0;
  let totalDrives = 0;

  async function acquire(surface: string, need = 1): Promise<void> {
    const live = inFlight.get(surface) ?? 0;
    const queued = waiters.get(surface)?.length ?? 0;
    if (queued === 0 && live + need <= cap) {
      inFlight.set(surface, live + need);
      return;
    }
    await new Promise<void>((resolve) => {
      const queue = waiters.get(surface) ?? [];
      queue.push({ need, resolve });
      waiters.set(surface, queue);
    });
  }

  function release(surface: string, held = 1): void {
    inFlight.set(surface, Math.max(0, (inFlight.get(surface) ?? held) - held));
    const queue = waiters.get(surface);
    while (queue && queue.length > 0) {
      const head = queue[0]!;
      const live = inFlight.get(surface) ?? 0;
      if (live + head.need > cap) return;
      queue.shift();
      inFlight.set(surface, live + head.need);
      head.resolve();
    }
  }

  return {
    async drive<T>(surface: string, channel: string, fn: () => Promise<T>): Promise<T> {
      await acquire(surface);
      try {
        const live = inFlight.get(surface) ?? 1;
        maxConcurrencyPerSurface.set(surface, Math.max(maxConcurrencyPerSurface.get(surface) ?? 0, live));
        const key = channelKey(surface, channel);
        const at = Math.max(clock.now(), nextAllowedAt.get(key) ?? 0);
        nextAllowedAt.set(key, at + floorMs);
        const wait = at - clock.now();
        if (wait > 0) {
          waitedMs += wait;
          await clock.sleep(wait);
        }
        drivesPerChannel.set(key, (drivesPerChannel.get(key) ?? 0) + 1);
        totalDrives++;
        return await fn();
      } finally {
        release(surface);
      }
    },
    async driveBurst<T>(surface: string, channels: readonly string[], fn: () => Promise<T>): Promise<T> {
      const unique = [...new Set(channels)];
      if (unique.length === 0) throw new Error("pacing burst requires at least one channel");
      if (unique.length > cap) {
        throw new Error(`pacing burst of ${unique.length} channels exceeds ${surface}'s concurrency cap ${cap}`);
      }
      await acquire(surface, unique.length);
      try {
        const live = inFlight.get(surface) ?? unique.length;
        maxConcurrencyPerSurface.set(surface, Math.max(maxConcurrencyPerSurface.get(surface) ?? 0, live));
        const now = clock.now();
        const at = Math.max(now, ...unique.map((channel) => nextAllowedAt.get(channelKey(surface, channel)) ?? 0));
        for (const channel of unique) nextAllowedAt.set(channelKey(surface, channel), at + floorMs);
        const wait = at - clock.now();
        if (wait > 0) {
          waitedMs += wait;
          await clock.sleep(wait);
        }
        for (const channel of unique) {
          const key = channelKey(surface, channel);
          drivesPerChannel.set(key, (drivesPerChannel.get(key) ?? 0) + 1);
          totalDrives++;
        }
        return await fn();
      } finally {
        release(surface, unique.length);
      }
    },
    stats(): PacingStats {
      return {
        drivesPerChannel: new Map(drivesPerChannel),
        maxConcurrencyPerSurface: new Map(maxConcurrencyPerSurface),
        waitedMs,
        totalDrives,
      };
    },
  };
}

export function renderPacingLine(stats: PacingStats, opts?: { readonly floorMs?: number; readonly maxConcurrentPerSurface?: number }): string {
  const floorMs = opts?.floorMs ?? PACING_CHANNEL_FLOOR_MS;
  const cap = opts?.maxConcurrentPerSurface ?? PACING_MAX_CONCURRENT_PER_SURFACE;
  const head = `pacing: floor ${floorMs}ms per channel, cap ${cap} concurrent per surface`;
  if (stats.totalDrives === 0) return `${head} — no drives this run`;
  const busiest = [...stats.drivesPerChannel.entries()].sort((a, b) => b[1] - a[1]);
  const perChannel = busiest.map(([key, n]) => `${key}=${n}`).join(", ");
  const concurrency = [...stats.maxConcurrencyPerSurface.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([surface, n]) => `${surface}=${n}`)
    .join(", ");
  return (
    `${head} — ${stats.totalDrives} drive(s) over ${stats.drivesPerChannel.size} channel(s): ${perChannel};` +
    ` max concurrency observed: ${concurrency || "none"}; held back ${(stats.waitedMs / 1000).toFixed(1)}s`
  );
}

export const PACED_DRIVER_METHODS: Readonly<Record<string, readonly string[]>> = {
  SlackDriver: ["post", "uploadImage", "update"],
  DiscordDriver: ["post"],
  TeamsDriver: ["postDm", "postMention", "postPlainRoot", "postReply", "postMentionReply"],
  GithubDriver: ["comment"],
  LinearDriver: ["comment", "assign"],
  NotionDriver: ["createBlockDiscussion", "replyToDiscussion"],
  SyntheticSlack: [],
  WebhookDriver: [],
  PrApi: [],
};

const CHANNEL_OF: Readonly<Record<string, (driver: Record<string, unknown>, args: readonly unknown[], method: string) => string>> = {
  SlackDriver: (d) => String(d.channelId ?? "?"),
  DiscordDriver: (d, args) => String(args[1] ?? d.channelId ?? "?"),
  TeamsDriver: (d, args, method) => String((method === "postDm" ? args[0] : undefined) ?? d.channelId ?? "?"),
  GithubDriver: (d) => String(d.repo ?? "?"),
  LinearDriver: (d, args) => String(args[0] ?? d.teamId ?? "?"),
  NotionDriver: (d) => String(d.pageId ?? "?"),
};

export function paceDriver<T extends object>(driver: T, surface: string, gate: PacingGate): T {
  const paced = PACED_DRIVER_METHODS[driver.constructor.name] ?? [];
  if (paced.length === 0) return driver;
  const names = new Set(paced);
  const channelOf = CHANNEL_OF[driver.constructor.name] ?? (() => driver.constructor.name);
  return new Proxy(driver, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop === "withChannel") {
        return (...args: unknown[]) => paceDriver((value as (...a: unknown[]) => T).apply(target, args), surface, gate);
      }
      if (typeof prop === "string" && names.has(prop)) {
        return (...args: unknown[]) =>
          gate.drive(surface, channelOf(target as unknown as Record<string, unknown>, args, prop), () =>
            (value as (...a: unknown[]) => Promise<unknown>).apply(target, args),
          );
      }
      return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args);
    },
  }) as T;
}

export function paceMaybe<T extends object>(driver: T | undefined, surface: string, gate: PacingGate): T | undefined {
  return driver === undefined ? undefined : paceDriver(driver, surface, gate);
}
