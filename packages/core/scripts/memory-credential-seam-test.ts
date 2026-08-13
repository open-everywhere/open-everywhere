
import { resolveMemoryPlan, siloAccess, type MemoryResolveConfig } from "../agent/memory/resolve.js";
import { defineDomain } from "../agent/memory/domain.js";
import { defineMemorySilo, type MemorySilo } from "../agent/memory/silo.js";
import { domainCredentialId } from "../agent/access/domain-credentials.js";
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

function binding(mode: SessionMode, trust: Trust): SurfaceBinding {
  return { org: "default", platform: "slack", workspace: "T", surface: "C", mode, visibility: "public", trust };
}
function partition(surface: string): Partition {
  const workspaceKey = "slack/T";
  const surfaceKey = `${workspaceKey}/${surface}`;
  return { org: "default", platform: "slack", workspace: "T", surface, workspaceKey, surfaceKey, key: surfaceKey };
}

function ownerOf(reads: readonly { silo: MemorySilo; access?: { domain?: { name?: string } } }[], siloName: string): string | null {
  const hit = reads.find((r) => r.silo.name === siloName);
  if (!hit) throw new Error(`no read for silo "${siloName}" (reads: ${reads.map((r) => r.silo.name).join(", ") || "none"})`);
  return hit.access?.domain?.name ?? null;
}

const NOTION = "notion";
const MEMORY_ROLE = "memory";
const PAY_MEMORY_CRED = "payments-memory-key";

const payBrain: MemorySilo = defineMemorySilo({ name: "pay-brain", provider: "notion", container: "page-pay", readOnly: true });
const supBrain: MemorySilo = defineMemorySilo({ name: "sup-brain", provider: "notion", container: "page-sup", readOnly: true });
const orgBase: MemorySilo = defineMemorySilo({ name: "org-base", provider: "notion", container: "page-org", readOnly: true });
const sharedBrain: MemorySilo = defineMemorySilo({ name: "shared", provider: "sqlite" });
const orphanSilo: MemorySilo = defineMemorySilo({ name: "orphan", provider: "sqlite" });
const pubFaq: MemorySilo = defineMemorySilo({ name: "pub-faq", provider: "sqlite", readOnly: true });
const dmShared: MemorySilo = defineMemorySilo({ name: "dm-shared", provider: "sqlite", readOnly: true });

const cfg: MemoryResolveConfig = {
  domains: [
    defineDomain({
      name: "payments",
      channels: ["slack/T/C_PAY"],
      memory: "pay-brain",
      includeOrg: "readonly",
      credentials: [{ provider: NOTION, credential: MEMORY_ROLE, use: PAY_MEMORY_CRED }],
    }),
    defineDomain({ name: "support", channels: ["slack/T/C_SUP"], memory: "sup-brain" }),
    defineDomain({ name: "alpha", channels: ["slack/T/C_A"], memory: "shared" }),
    defineDomain({ name: "beta", channels: ["slack/T/C_B"], memory: "shared" }),
    defineDomain({ name: "org", match: "org", memory: "org-base" }),
    defineDomain({ name: "public", match: "public", memory: "pub-faq" }),
    defineDomain({ name: "dm", match: "dm", memory: "dm-shared" }),
  ],
  silos: [payBrain, supBrain, orgBase, sharedBrain, orphanSilo, pubFaq, dmShared],
};

{
  const pay = resolveMemoryPlan(binding("channel", "internal"), partition("C_PAY"), cfg);
  ok(ownerOf(pay.reads, "pay-brain") === "payments", "a domain's OWN silo is read as that domain");
  ok(ownerOf(pay.reads, "org-base") === "org", "the includeOrg slice is read as the ORG, not as the domain that pulled it in");
  ok(ownerOf(pay.reads, "org-base") !== "payments", "negative control: the org slice is NOT attributed to the borrowing domain");

  const sup = resolveMemoryPlan(binding("channel", "internal"), partition("C_SUP"), cfg);
  ok(ownerOf(sup.reads, "sup-brain") === "support", "an UNBOUND domain is still stamped — 'no binding' is decided downstream, not by omitting the domain");

  const loose = resolveMemoryPlan(binding("channel", "internal"), partition("C_NONE"), cfg);
  ok(ownerOf(loose.reads, "org-base") === "org", "an unassigned channel reads the org silo as the org");

  const ext = resolveMemoryPlan(binding("channel", "external"), partition("C_PAY"), cfg);
  ok(ownerOf(ext.reads, "pub-faq") === "public", "an external channel reads the public silo as the `public` pseudo-domain");
  ok(ext.reads.every((r) => r.silo.name !== "pay-brain"), "negative control: the trust gate still keeps the bound domain's brain out of an external session");

  const dm = resolveMemoryPlan(binding("dm", "internal"), partition("D_1"), cfg);
  ok(ownerOf(dm.reads, "@personal") === null, "the personal DB silo carries NO owning domain");
  ok(ownerOf(dm.reads, "dm-shared") === "dm", "…while the DM shared layer is read as the `dm` pseudo-domain");

  const alpha = resolveMemoryPlan(binding("channel", "internal"), partition("C_A"), cfg);
  ok(alpha.writes.length === 1 && ownerOf(alpha.writes, "shared") === "alpha", "a WRITE carries the same owning domain as its read");
}

{
  ok(siloAccess("pay-brain", cfg.domains).domain?.name === "payments", "one owner ⇒ that domain");
  ok(siloAccess("org-base", cfg.domains).domain?.name === "org", "the org silo's owner is the org pseudo-domain");

  ok(siloAccess("shared", cfg.domains).domain === undefined, "TWO owners ⇒ NO domain (the org default), never an arbitrary pick");
  ok(siloAccess("orphan", cfg.domains).domain === undefined, "a silo no domain names ⇒ no domain");
  ok(siloAccess("no-such-silo", cfg.domains).domain === undefined, "an unknown silo name ⇒ no domain");
}

{
  const pay = resolveMemoryPlan(binding("channel", "internal"), partition("C_PAY"), cfg);
  const payRead = pay.reads.find((r) => r.silo.name === "pay-brain")!;
  const orgRead = pay.reads.find((r) => r.silo.name === "org-base")!;
  const sup = resolveMemoryPlan(binding("channel", "internal"), partition("C_SUP"), cfg);
  const supRead = sup.reads.find((r) => r.silo.name === "sup-brain")!;

  ok(
    domainCredentialId(payRead.access?.domain, NOTION, MEMORY_ROLE) === PAY_MEMORY_CRED,
    "a BOUND domain's read resolves that domain's own credential id",
  );
  ok(
    domainCredentialId(supRead.access?.domain, NOTION, MEMORY_ROLE) === MEMORY_ROLE,
    "an UNBOUND domain's read resolves the ORG-DEFAULT role — absence of a binding falls back, never refuses",
  );
  ok(
    domainCredentialId(orgRead.access?.domain, NOTION, MEMORY_ROLE) === MEMORY_ROLE,
    "the includeOrg slice resolves the org default even inside a BOUND domain's session",
  );
  ok(
    domainCredentialId(payRead.access?.domain, NOTION, MEMORY_ROLE) !== domainCredentialId(supRead.access?.domain, NOTION, MEMORY_ROLE),
    "negative control: the two domains genuinely resolve DIFFERENT credentials",
  );
  ok(
    domainCredentialId(payRead.access?.domain, NOTION, "channel-key") === "channel-key",
    "a MEMORY binding leaves the channel-key role on the org default — roles are independent",
  );
  ok(
    domainCredentialId(payRead.access?.domain, "github", MEMORY_ROLE) === MEMORY_ROLE,
    "negative control: the binding is provider-scoped — another provider's memory role is untouched",
  );
}

console.log(`✓ memory-credential-seam: ${passed} assertions passed`);
