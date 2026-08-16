import { appendAudit, readAudit } from "../../audit/audit.js";

export interface RecurrenceLedger {
  observe(key: string, dedupeKey?: string): Promise<number>;
  count(key: string): Promise<number>;
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "is", "are",
  "was", "were", "be", "by", "at", "as", "it", "its", "this", "that", "from", "please", "can",
  "you", "your", "we", "our", "me", "my", "i", "do", "does", "did", "have", "has", "will",
  "would", "could", "should", "let", "lets", "get", "got", "now", "then", "there", "here",
]);

export function workflowSignature(request: string): string {
  const words = request
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
  return [...new Set(words)].sort().join(" ").slice(0, 160);
}

export function inMemoryLedger(): RecurrenceLedger {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  return {
    async observe(key, dedupeKey) {
      if (dedupeKey !== undefined) {
        const mark = `${dedupeKey}\u0000${key}`;
        if (seen.has(mark)) return counts.get(key) ?? 0;
        seen.add(mark);
      }
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n;
    },
    async count(key) {
      return counts.get(key) ?? 0;
    },
  };
}

const DELIVERY_FIELD = "delivery";

export function auditRecurrenceLedger(org: string): RecurrenceLedger {
  const rowsFor = async (key: string) => {
    const rows = await readAudit({ org, action: "memory.observation" });
    return rows.filter((r) => r.detail?.["key"] === key);
  };
  const matches = async (key: string): Promise<number> => (await rowsFor(key)).length;
  return {
    async observe(key, dedupeKey) {
      if (dedupeKey !== undefined) {
        const existing = await rowsFor(key);
        if (existing.some((r) => r.detail?.[DELIVERY_FIELD] === dedupeKey)) return existing.length;
      }
      await appendAudit({
        org,
        platform: "memory",
        workspace: "@recurrence",
        action: "memory.observation",
        detail: { key, ...(dedupeKey !== undefined ? { [DELIVERY_FIELD]: dedupeKey } : {}) },
      });
      return matches(key);
    },
    count: matches,
  };
}
