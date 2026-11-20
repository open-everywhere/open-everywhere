import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beginMemoryProvenanceTurn, envelopeWrappedThisTurn, noteEnvelopeWrapThisTurn } from "../agent/memory/turn-provenance.js";
import { hostAuthoredModelOutput, ingestUntrusted, ingestUntrustedModelOutput, wrapUntrusted } from "../agent/access/untrusted.js";
import { overrideSettingsForTest } from "../agent/settings/settings.js";
import { pinSuiteStore } from "./_suite-store.js";
// eve 1.x keeps `{ context, values }` in its ALS. The fixture container carries both shapes.
const asEveStore = <T extends object>(c: T): T => Object.assign(c, { context: c, values: new Map<unknown, unknown>() });

pinSuiteStore("memory-turn-provenance");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

ok(envelopeWrappedThisTurn(undefined) === false, "no context: the reader says false");
noteEnvelopeWrapThisTurn();
beginMemoryProvenanceTurn("turn-x");
ok(envelopeWrappedThisTurn("turn-x") === false, "no context: the setter and the boundary are no-ops and never throw");
ok(wrapUntrusted("hello").includes("hello"), "no context: a wrap still renders its body");

class FakeSession {
  private readonly store = new Map<string, unknown>();
  get<T>(key: { name: string }): T | undefined {
    return this.store.get(key.name) as T | undefined;
  }
  has(key: { name: string }): boolean {
    return this.store.has(key.name);
  }
  require<T>(key: { name: string }): T {
    if (!this.has(key)) throw new Error(`missing ${key.name}`);
    return this.get(key) as T;
  }
  set<T>(key: { name: string }, v: T | ((c: T | undefined) => T)): T {
    const next = typeof v === "function" ? (v as (c: T | undefined) => T)(this.get(key)) : v;
    this.store.set(key.name, next);
    return next;
  }
  ensure<T>(key: { name: string }, create: () => T): T {
    return this.has(key) ? this.require(key) : this.set(key, create());
  }
  clearVirtualContext(): void {}
  setVirtualContext(): void {}
  *entries(): Generator<readonly [unknown, unknown]> {}
}

function eveContextStorage(): AsyncLocalStorage<unknown> {
  const g = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("eve.context-storage");
  g[key] ??= new AsyncLocalStorage();
  return g[key] as AsyncLocalStorage<unknown>;
}

async function inSession<T>(fn: () => T | Promise<T>): Promise<T> {
  return eveContextStorage().run(asEveStore(new FakeSession()), fn);
}

await inSession(async () => {
  beginMemoryProvenanceTurn("t1");
  ok(envelopeWrappedThisTurn("t1") === false, "a turn opens with the flag clear");
  hostAuthoredModelOutput("a host-built status line", { source: "host" });
  ok(envelopeWrappedThisTurn("t1") === false, "a host-authored fence holds no outside bytes, so it does not set the flag");
  wrapUntrusted("a page", { source: "web" });
  ok(envelopeWrappedThisTurn("t1") === true, "wrapUntrusted sets the flag");
});
await inSession(async () => {
  beginMemoryProvenanceTurn("t1");
  ingestUntrusted("a page", { source: "web" });
  ok(envelopeWrappedThisTurn("t1") === true, "ingestUntrusted sets the flag");
});
await inSession(async () => {
  beginMemoryProvenanceTurn("t1");
  await ingestUntrustedModelOutput("a tool result", { source: "notion" });
  ok(envelopeWrappedThisTurn("t1") === true, "ingestUntrustedModelOutput (the tool-result funnel) sets the flag");
});
await inSession(async () => {
  ok(envelopeWrappedThisTurn("t1") === false, "a fresh session does not see another session's flag, even for the same turn id");
});

const trustedSource = { kind: "chat-message", label: "read_channel:test" } as const;
await inSession(async () => {
  beginMemoryProvenanceTurn("t1");
  await ingestUntrustedModelOutput("a member's channel message", { source: "slack", ingestion: trustedSource });
  ok(envelopeWrappedThisTurn("t1") === true, "the memory flag ignores a deprecated source declaration: a once-trusted-tier wrap still sets it");
});

overrideSettingsForTest({ taint: { mode: "off" } });
await inSession(async () => {
  beginMemoryProvenanceTurn("t1");
  wrapUntrusted("a page", { source: "web" });
  ok(envelopeWrappedThisTurn("t1") === true, "the ignored taint.mode off does not disarm the memory flag");
});
overrideSettingsForTest({ taint: { mode: "on" } });

await inSession(async () => {
  beginMemoryProvenanceTurn("t1");
  wrapUntrusted("a page");
  ok(envelopeWrappedThisTurn("t1") === true, "turn 1 wrapped");
  beginMemoryProvenanceTurn("t1");
  ok(envelopeWrappedThisTurn("t1") === true, "a re-entered boundary for the same turn keeps the flag");
  ok(envelopeWrappedThisTurn("t2") === false, "a turn-1 flag reads clear from turn 2 even with no boundary between them");
  ok(envelopeWrappedThisTurn(undefined) === false, "a turn-1 flag reads clear for a reader that cannot name its turn");
  beginMemoryProvenanceTurn("t2");
  ok(envelopeWrappedThisTurn("t2") === false, "turn 2 opens clear after a wrapped turn 1");
  ok(envelopeWrappedThisTurn("t1") === false, "the boundary cleared the flag itself, not only the reader's view of it");
  wrapUntrusted("a page");
  beginMemoryProvenanceTurn(undefined);
  ok(envelopeWrappedThisTurn(undefined) === false, "a boundary with no turn id clears the flag");
  ok(envelopeWrappedThisTurn("t2") === false, "…and the old turn's flag is gone");
  wrapUntrusted("a page");
  ok(envelopeWrappedThisTurn(undefined) === true, "a turn with no id still marks its own wraps");
});

const agentDir = join(dirname(fileURLToPath(import.meta.url)), "..", "agent");
const memoryFiles: string[] = [join(agentDir, "hooks", "memory.ts")];
const walk = (dir: string): void => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".ts")) memoryFiles.push(p);
  }
};
walk(join(agentDir, "memory"));
const TAINT_IMPORT = /(?:from\s+|import\(\s*)["'][^"']*\/(?:taint-signal|taint-enforcement|taint-tiers)\.js["']/;
const TAINT_SETTING = /\.taint\s*\.\s*(?:mode|tierMode|undeclaredSurface)\b|getSettings\(\)\s*\.\s*taint\b/;
const readsTaint = (src: string): boolean => TAINT_IMPORT.test(src) || TAINT_SETTING.test(src);
const offenders = memoryFiles.filter((f) => readsTaint(readFileSync(f, "utf8"))).map((f) => relative(agentDir, f));
ok(memoryFiles.length > 10, "premise: the scan found the memory modules");
ok(offenders.length === 0, `no memory module imports the taint bit, the taint setting or a source tier (found: ${offenders.join(", ")})`);
ok(readsTaint(`import { untrustedIngestedThisTurn } from "../access/taint-signal.js";`), "negative control: the scan matches a static taint import");
ok(readsTaint(`const m = await import("../access/taint-enforcement.js");`), "negative control: the scan matches a dynamic taint import");
ok(readsTaint(`if (getSettings().taint.mode === "off") return;`), "negative control: the scan matches a read of the taint setting");
ok(!readsTaint(`// the taint rule: names and counts only`), "negative control: the scan ignores the word in prose");

console.log(`memory-turn-provenance: ${n} assertions passed`);
