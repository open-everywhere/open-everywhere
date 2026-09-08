import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const NOTION = "notion/40000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000101";
const SLACK_MEM = "slack/T0EXAMPLE/C0EXCHAN005";
const DOMAIN_REASONING_CEILING = "high";
const UNMOVED = [
  "slack/T0EXAMPLE/C0EXCHAN003",
  "slack/T0EXAMPLE/C0EXRANDM",
  "github/example-owner/e2e-scratch",
  "discord/1300000000000000100/1300000000000000101",
  "linear/1a000000-0000-4000-8000-000000000001/1a000000-0000-4000-8000-000000000011",
];

type Snapshot = {
  readonly resolved: Record<string, string | null>;
  readonly names: readonly string[];
  readonly reach: Record<string, readonly string[]>;
  readonly ceilings: Record<string, string | null>;
};

const PROBE_KEYS = [NOTION, SLACK_MEM, ...UNMOVED];

if (process.argv.includes("--probe")) {
  const { loadDomains, domainsForSurface } = await import("../agent/memory/config/domains.js");
  const domains = loadDomains();
  const resolve = (key: string): string | null => {
    const [platform, workspace, ...rest] = key.split("/");
    const names = domainsForSurface({ workspaceKey: `${platform}/${workspace}`, surface: rest.join("/") });
    return names[0] ?? null;
  };
  const snapshot: Snapshot = {
    resolved: Object.fromEntries(PROBE_KEYS.map((k) => [k, resolve(k)])),
    names: domains.map((d) => d.name),
    reach: Object.fromEntries(
      domains.filter((d) => ["e2e-unified", "e2e-memory", "e2e-b"].includes(d.name)).map((d) => [d.name, [...(d.reach ?? [])]]),
    ),
    ceilings: Object.fromEntries(
      domains.filter((d) => ["e2e-unified", "e2e-memory"].includes(d.name)).map((d) => [d.name, d.reasoningCeiling ?? null]),
    ),
  };
  process.stdout.write(`__SNAPSHOT__${JSON.stringify(snapshot)}`);
  process.exit(0);
}

const SELF = fileURLToPath(import.meta.url);

function snapshotUnder(memoryEval: "1" | "off"): Snapshot {
  const env = { ...process.env };
  if (memoryEval === "1") env.OE_MEMORY_EVAL = "1";
  else delete env.OE_MEMORY_EVAL;
  const r = spawnSync(process.execPath, [...process.execArgv, SELF, "--probe"], { env, encoding: "utf8" });
  const out = `${r.stdout ?? ""}`;
  const marker = out.indexOf("__SNAPSHOT__");
  if (r.status !== 0 || marker < 0) {
    throw new Error(
      `domains.ts failed to load with OE_MEMORY_EVAL=${memoryEval} (exit ${r.status}) — the module-load ` +
        `validators (channel exclusivity / domain shape / unified trust) rejected the config.\n` +
        `stdout: ${out}\nstderr: ${r.stderr ?? ""}`,
    );
  }
  return JSON.parse(out.slice(marker + "__SNAPSHOT__".length)) as Snapshot;
}

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const off = snapshotUnder("off");
const on = snapshotUnder("1");
ok(true, "domains.ts loads clean with OE_MEMORY_EVAL unset (channel exclusivity + unified trust pass)");
ok(true, "domains.ts loads clean with OE_MEMORY_EVAL=1 (channel exclusivity + unified trust pass)");

{
  ok(off.resolved[NOTION] === "e2e-unified", `flag off: Notion surface resolves to e2e-unified (got ${off.resolved[NOTION]})`);
  ok(!off.names.includes("e2e-memory"), "flag off: the e2e-memory battery domain is not registered at all");
  ok(off.resolved[SLACK_MEM] === "e2e-b", `flag off: the battery's Slack channel belongs to e2e-b (got ${off.resolved[SLACK_MEM]})`);
  ok((off.reach["e2e-unified"] ?? []).includes(NOTION), "flag off: e2e-unified lists the Notion surface");
}

{
  ok(on.resolved[NOTION] === "e2e-memory", `flag on: Notion surface resolves to e2e-memory (got ${on.resolved[NOTION]}) — M4 can inject`);
  ok(on.resolved[NOTION] !== "e2e-unified", "flag on: the Notion surface is NOT still on e2e-unified");
  ok(!(on.reach["e2e-unified"] ?? []).includes(NOTION), "flag on: e2e-unified has dropped the Notion surface (exclusivity is why M4 was dead)");
  const mem = on.reach["e2e-memory"] ?? [];
  ok(mem.includes(NOTION), "flag on: e2e-memory lists the Notion surface");
  ok(mem.includes(SLACK_MEM), "flag on: e2e-memory still lists the battery Slack channel");
  ok(new Set(mem.map((k) => k.split("/")[0])).size >= 2, "flag on: e2e-memory spans >1 PLATFORM — the precondition M4's one-brain claim needs");
  ok(on.resolved[SLACK_MEM] === "e2e-memory", `flag on: the Slack channel is on loan from e2e-b (got ${on.resolved[SLACK_MEM]})`);
  ok(!on.names.includes("e2e-b"), "flag on: e2e-b has yielded (gated out), which is what frees its Slack channel");
  ok(
    on.ceilings["e2e-memory"] === DOMAIN_REASONING_CEILING,
    `flag on: e2e-memory declares reasoningCeiling "${DOMAIN_REASONING_CEILING}" (got ${on.ceilings["e2e-memory"] ?? "none — every --effort high run silently clamps to the org default"})`,
  );
}

for (const key of UNMOVED) {
  ok(
    off.resolved[key] === "e2e-unified" && on.resolved[key] === "e2e-unified",
    `blast radius: ${key} stays on e2e-unified in BOTH flag states (off=${off.resolved[key]} on=${on.resolved[key]})`,
  );
}

console.log(`memory-eval-fixture: ${n} assertions passed`);
