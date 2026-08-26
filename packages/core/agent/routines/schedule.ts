export interface CronField {
  readonly star: boolean;
  has(n: number): boolean;
}

export interface ParsedCron {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dom: CronField;
  readonly month: CronField;
  readonly dow: CronField;
}

const MIN = 60_000;

export const DISPATCH_TICK_MINUTES = 10;

function field(values: ReadonlySet<number>, star: boolean): CronField {
  return { star, has: (n) => star || values.has(n) };
}

function parseField(spec: string, lo: number, hi: number): CronField {
  const raw = spec.trim();
  if (raw === "*") return field(new Set(), true);

  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);

    let start = lo;
    let end = hi;
    if (rangePart !== "*" && rangePart !== "") {
      const bounds = rangePart.split("-");
      if (bounds.length === 1) {
        start = end = Number(bounds[0]);
      } else if (bounds.length === 2) {
        start = Number(bounds[0]);
        end = Number(bounds[1]);
      } else {
        throw new Error(`bad range in "${part}"`);
      }
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < lo || end > hi || start > end) {
      throw new Error(`out-of-range field "${part}" (allowed ${lo}-${hi})`);
    }
    for (let n = start; n <= end; n += step) out.add(n);
  }
  return field(out, false);
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron must have 5 fields (min hour dom mon dow), got ${parts.length}: "${expr}"`);
  }
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dom: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dow: parseField(parts[4], 0, 6),
  };
}

export function cronMatches(c: ParsedCron, date: Date): boolean {
  if (!c.minute.has(date.getUTCMinutes())) return false;
  if (!c.hour.has(date.getUTCHours())) return false;
  if (!c.month.has(date.getUTCMonth() + 1)) return false;

  const dom = date.getUTCDate();
  const dow = date.getUTCDay();
  if (!c.dom.star && !c.dow.star) return c.dom.has(dom) || c.dow.has(dow);
  return c.dom.has(dom) && c.dow.has(dow);
}

function floorToMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / MIN) * MIN);
}

export function nextCronAfter(c: ParsedCron, from: Date): Date | null {
  const start = floorToMinute(from).getTime() + MIN;
  const limit = 367 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    const t = new Date(start + i * MIN);
    if (cronMatches(c, t)) return t;
  }
  return null;
}

type Trigger =
  | { kind: "cron"; expr: string }
  | { kind: "interval"; everyMinutes: number }
  | { kind: "watch"; everyMinutes?: number; expr?: string }
  | { kind: "once"; at: string }
  | { kind: "event"; source: string };

function nextIntervalAfter(anchor: Date, everyMinutes: number, notBefore: Date): Date {
  const period = Math.max(1, everyMinutes) * MIN;
  const base = anchor.getTime();
  const floor = notBefore.getTime();
  if (base + period > floor) return new Date(base + period);
  return new Date(base + (Math.floor((floor - base) / period) + 1) * period);
}

export function computeNextRun(trigger: Trigger, from: Date, notBefore: Date = from): Date | null {
  const cronFrom = notBefore.getTime() > from.getTime() ? notBefore : from;
  switch (trigger.kind) {
    case "cron":
      return nextCronAfter(parseCron(trigger.expr), cronFrom);
    case "watch":
      if (trigger.expr !== undefined) return nextCronAfter(parseCron(trigger.expr), cronFrom);
      return trigger.everyMinutes === undefined ? null : nextIntervalAfter(from, trigger.everyMinutes, notBefore);
    case "interval":
      return nextIntervalAfter(from, trigger.everyMinutes, notBefore);
    case "once":
      return null;
    case "event":
      return null;
  }
}

export function isDue(nextRunAt: string | null | undefined, now: Date): boolean {
  if (!nextRunAt) return false;
  const t = Date.parse(nextRunAt);
  return Number.isFinite(t) && t <= now.getTime();
}
