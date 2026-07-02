import { appendAudit, readAudit } from "../../audit/audit.js";

export interface RecurrenceLedger {
  observe(key: string): Promise<number>;
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
  return {
    async observe(key) {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n;
    },
    async count(key) {
      return counts.get(key) ?? 0;
    },
  };
}

export function auditRecurrenceLedger(org: string): RecurrenceLedger {
  const matches = async (key: string): Promise<number> => {
    const rows = await readAudit({ org, action: "memory.observation" });
    return rows.filter((r) => r.detail?.["key"] === key).length;
  };
  return {
    async observe(key) {
      await appendAudit({ org, platform: "memory", workspace: "@recurrence", action: "memory.observation", detail: { key } });
      return matches(key);
    },
    count: matches,
  };
}
