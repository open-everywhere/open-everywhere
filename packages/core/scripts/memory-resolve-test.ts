import { resolveMemoryPlan, type MemoryResolveConfig } from "../agent/memory/resolve.js";
import { defineDomain, domainForChannel, assertChannelExclusivity } from "../agent/memory/domain.js";
import { defineMemorySilo, type MemorySilo } from "../agent/memory/silo.js";
import type { SurfaceBinding, Trust } from "../agent/identity/binding.js";
import type { SessionMode } from "../agent/access/resolver.js";
import type { Partition } from "../agent/memory/partition.js";

delete process.env.OE_MEMORY_PROVIDER;

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
function throws(fn: () => unknown, label: string): void {
  try {
    fn();
    console.error(`✗ ${label} (expected throw)`);
    process.exit(1);
  } catch {
    passed++;
  }
}

function binding(mode: SessionMode, trust: Trust): SurfaceBinding {
  return { org: "default", platform: "slack", workspace: "T", surface: "C", mode, visibility: "public", trust };
}
function partition(surface: string): Partition {
  const workspaceKey = "slack/T";
  const surfaceKey = `${workspaceKey}/${surface}`;
  return { org: "default", platform: "slack", workspace: "T", surface, workspaceKey, surfaceKey, key: surfaceKey };
}

const txnSilo: MemorySilo = defineMemorySilo({ name: "txn", provider: "sqlite" });
const baselineSilo: MemorySilo = defineMemorySilo({ name: "baseline", provider: "sqlite", readOnly: true });

const cfg: MemoryResolveConfig = {
  domains: [
    defineDomain({ name: "transactions", channels: ["slack/T/C_TXN"], memory: "txn", bundle: "txn-tools" }),
    defineDomain({ name: "watercooler", channels: ["slack/T/C_CHAT"] }),
    defineDomain({ name: "readonly-dom", channels: ["slack/T/C_RO"], memory: "baseline" }),
    defineDomain({ name: "multi", channels: ["slack/T/C_MULTI"], memory: ["txn", "baseline"] }),
    defineDomain({ name: "multi2", channels: ["slack/T/C_MULTI2"], memory: ["baseline"] }),
  ],
  silos: [txnSilo, baselineSilo],
  orgDefault: undefined,
};

const mpim = resolveMemoryPlan(binding("mpim", "internal"), partition("C_TXN"), cfg);
ok(mpim.reads.length === 0 && mpim.writes.length === 0, "mpim → no memory");

const dm = resolveMemoryPlan(binding("dm", "internal"), partition("Duser"), cfg);
ok(dm.reads.length === 1 && dm.writes.length === 1, "dm → reads + writes one personal silo");
ok(dm.reads[0].silo.name === "@personal" && dm.reads[0].silo.provider === "sqlite", "dm → personal silo pinned to DB (sqlite)");
ok(dm.reads[0].tier.kind === "surface" && dm.writes[0].readOnly === false, "dm → SURFACE tier, writable");

const ext = resolveMemoryPlan(binding("channel", "external"), partition("C_TXN"), cfg);
ok(ext.reads.length === 0 && ext.writes.length === 0, "external channel in a domain → NO memory (gate beats config)");
ok(ext.reason.includes("trust gate"), "external → reason names the trust gate");

const txn = resolveMemoryPlan(binding("channel", "internal"), partition("C_TXN"), cfg);
ok(txn.reads.length === 1 && txn.writes.length === 1, "domain channel → reads + writes its silo");
ok(txn.reads[0].silo.name === "txn" && txn.reads[0].tier.kind === "silo", "domain channel → the domain's silo + silo tier");
ok(txn.reads[0].tier.kind === "silo" && txn.reads[0].tier.name === "txn", "silo tier keyed by SILO name (not domain)");

const multi = resolveMemoryPlan(binding("channel", "internal"), partition("C_MULTI"), cfg);
ok(multi.reads.length === 2, "multi-source domain → reads BOTH silos");
ok(multi.writes.length === 1 && multi.writes[0].silo.name === "txn", "multi-source → writes only the writable silo");
ok(multi.reads.some((r) => r.silo.name === "baseline" && r.readOnly), "multi-source → baseline included read-only");
const multi2 = resolveMemoryPlan(binding("channel", "internal"), partition("C_MULTI2"), cfg);
const baseTierA = multi.reads.find((r) => r.silo.name === "baseline")!.tier;
const baseTierB = multi2.reads[0].tier;
ok(baseTierA.kind === "silo" && baseTierB.kind === "silo" && baseTierA.name === baseTierB.name, "shared silo → SAME bucket across domains");

const ro = resolveMemoryPlan(binding("channel", "internal"), partition("C_RO"), cfg);
ok(ro.reads.length === 1 && ro.writes.length === 0, "read-only silo → reads, never writes");
ok(ro.reads[0].readOnly === true, "read-only silo → marked readOnly");

const group = resolveMemoryPlan(binding("channel", "internal"), partition("C_CHAT"), cfg);
ok(group.reads.length === 0 && group.writes.length === 0, "domain w/o silo → no memory (grouping only)");

const unassigned = resolveMemoryPlan(binding("channel", "internal"), partition("C_RANDOM"), cfg);
ok(unassigned.reads.length === 0 && unassigned.writes.length === 0, "unassigned + org default off → no memory");

const withDefault: MemoryResolveConfig = {
  ...cfg,
  orgDefault: { enabled: true, memory: "baseline", bundle: "org-default" },
};
const od = resolveMemoryPlan(binding("channel", "internal"), partition("C_RANDOM"), withDefault);
ok(od.reads.length === 1 && od.writes.length === 0, "unassigned + org default on → reads baseline, no writes");
ok(od.reads[0].tier.kind === "silo" && od.reads[0].readOnly === true, "org default → silo tier (the baseline silo), read-only");

const odExt = resolveMemoryPlan(binding("channel", "external"), partition("C_RANDOM"), withDefault);
ok(odExt.reads.length === 0, "external unassigned + org default on → still NO memory (gate first)");

const txnWithDefault = resolveMemoryPlan(binding("channel", "internal"), partition("C_TXN"), withDefault);
ok(txnWithDefault.reads.length === 1 && txnWithDefault.reads[0].silo.name === "txn", "domain channel ignores org default (single source, v1)");

throws(
  () => resolveMemoryPlan(binding("channel", "internal"), partition("C_TXN"), { domains: cfg.domains, silos: [], orgDefault: undefined }),
  "referencing an undefined silo throws",
);

ok(domainForChannel("slack/T/C_TXN", cfg.domains)?.name === "transactions", "domainForChannel finds the owner");
ok(domainForChannel("slack/T/C_NOPE", cfg.domains) === undefined, "domainForChannel → undefined when none");

assertChannelExclusivity(cfg.domains);
ok(true, "exclusivity: disjoint domains pass");
throws(
  () =>
    assertChannelExclusivity([
      defineDomain({ name: "a", channels: ["slack/T/C1"] }),
      defineDomain({ name: "b", channels: ["slack/T/C1"] }),
    ]),
  "exclusivity: a channel in two domains throws",
);

console.log(`✓ memory-resolve: ${passed} assertions passed`);
