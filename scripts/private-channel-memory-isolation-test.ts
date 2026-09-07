import assert from "node:assert/strict";
import { loadDomains, loadSilos } from "../agent/memory/config/domains.js";
import { resolveMemoryPlan, type MemoryResolveConfig } from "@open-everywhere/core/agent/memory/resolve.js";
import { domainForChannel, criteriaDomain, memoryRefs } from "@open-everywhere/core/agent/memory/domain.js";
import type { SurfaceBinding } from "@open-everywhere/core/agent/identity/binding.js";
import type { Partition } from "@open-everywhere/core/agent/memory/partition.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const WORKSPACE = "T0EXAMPLE";
const PROBE_CHANNEL = "C0EXCHAN003";
const SAME_DOMAIN_CHANNEL = "C0EXRANDM";
const UNASSIGNED_CHANNEL = "C_OPE1458_UNASSIGNED";

const cfg: MemoryResolveConfig = { domains: loadDomains(), silos: loadSilos() };

function channelBinding(surface: string, visibility: "public" | "private"): SurfaceBinding {
  return { org: "default", platform: "slack", workspace: WORKSPACE, surface, mode: "channel", visibility, trust: "internal" };
}

function channelPartition(surface: string): Partition {
  const workspaceKey = `slack/${WORKSPACE}`;
  const surfaceKey = `${workspaceKey}/${surface}`;
  return { org: "default", platform: "slack", workspace: WORKSPACE, surface, workspaceKey, surfaceKey, key: surfaceKey };
}

const siloNames = (rs: readonly { readonly silo: { readonly name: string } }[]): Set<string> => new Set(rs.map((r) => r.silo.name));
const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => [...a].some((x) => b.has(x));

const privatePlan = resolveMemoryPlan(channelBinding(UNASSIGNED_CHANNEL, "private"), channelPartition(UNASSIGNED_CHANNEL), cfg);
const probePlan = resolveMemoryPlan(channelBinding(PROBE_CHANNEL, "public"), channelPartition(PROBE_CHANNEL), cfg);

ok(privatePlan.reads.length > 0, "an unassigned internal channel resolves SOME memory (the org fallback) — not a vacuous plan");
ok(probePlan.reads.length > 0, "S11's public probe channel resolves SOME memory — not a vacuous plan");

ok(domainForChannel(`slack/${WORKSPACE}/${UNASSIGNED_CHANNEL}`, cfg.domains) === undefined, "the unassigned channel is in NO explicit domain");
const probeDomain = domainForChannel(`slack/${WORKSPACE}/${PROBE_CHANNEL}`, cfg.domains);
ok(probeDomain !== undefined, "S11's probe channel IS in an explicit domain — this is the mechanism, so it must hold");
ok(probeDomain?.includeOrg === undefined, "that domain sets no includeOrg — arming it would pull the org silo into the probe's reads");

const org = criteriaDomain("org", cfg.domains);
ok(org !== undefined, "the org pseudo-domain is defined — the unassigned channel's fallback target");
const orgSilos = new Set(org ? memoryRefs(org) : []);
ok(intersects(siloNames(privatePlan.reads), orgSilos), "the unassigned channel reads the ORG silos (the single-hop fallback)");
ok(intersects(siloNames(privatePlan.writes), orgSilos), "the unassigned channel WRITES the ORG silos — no gate refuses it (OPE-1458)");

const privateTouches = new Set([...siloNames(privatePlan.reads), ...siloNames(privatePlan.writes)]);
ok(
  !intersects(privateTouches, siloNames(probePlan.reads)),
  "no silo an unassigned private channel reads or writes is in S11's public probe channel's read plan",
);

const sameDomainPlan = resolveMemoryPlan(channelBinding(SAME_DOMAIN_CHANNEL, "public"), channelPartition(SAME_DOMAIN_CHANNEL), cfg);
ok(
  intersects(siloNames(sameDomainPlan.reads), siloNames(probePlan.reads)),
  "negative control: a channel in the SAME domain DOES share the probe's silos — the disjointness check is not vacuous",
);

ok(privatePlan.reads.every((r) => r.tier.kind !== "surface"), "a CHANNEL plan carries no surface-tier entry — there is no per-channel surface silo");
const dmPlan = resolveMemoryPlan(
  { org: "default", platform: "slack", workspace: WORKSPACE, surface: "D_OPE1458", mode: "dm", visibility: "private", trust: "internal" },
  channelPartition("D_OPE1458"),
  cfg,
);
ok(dmPlan.reads.some((r) => r.tier.kind === "surface"), "positive control: a DM plan DOES carry a surface-tier entry");

console.log(`✓ private-channel-memory-isolation: ${n} assertions passed`);
