
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const dir = join(tmpdir(), `open-everywhere-unified-audit-test-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
process.env.OE_SQLITE_PATH = join(dir, "ops.sqlite3");
process.env.OE_ORG = "acme";
process.env.OE_WINDOW_TOPOLOGY = "1";
delete process.env.OE_CONTROL_READ_TOKENS;

const { registerConfig } = await import("../agent/access/config.js");
const { defineBundle, defineBinding } = await import("../agent/access/bundle.js");
const { defineDomain, domainForChannel } = await import("../agent/memory/domain.js");
const { definePrincipal } = await import("../agent/identity/principals.js");

const SLACK = "slack/T1/C_PAY";
const GH = "github/acme/repo";
const payments = defineDomain({
  name: "payments",
  channels: [SLACK, GH],
  ambientSupervisor: true,
  mode: "unified",
  admins: ["slack/T1/U_ADMIN"],
});
const org = defineDomain({ name: "org", match: "org" });
const domains = [payments, org];

registerConfig({
  loadBundles: () => [
    defineBundle({ name: "base", domains: ["api.example.com"] }),
    defineBundle({ name: "gh-extra", domains: ["deploy.example.com"] }),
  ],
  loadBindings: () => [
    defineBinding({ bundle: "base", scope: { level: "org" } }),
    defineBinding({ bundle: "gh-extra", scope: { level: "surface", surface: "github/acme/repo" } }),
  ],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => domains,
  loadSilos: () => [],
  domainsForSurface: ({ workspaceKey, surface }) => {
    const d = domainForChannel(`${workspaceKey}/${surface}`, domains);
    return d ? [d.name] : [];
  },
  loadPrincipals: () => [
    definePrincipal({ name: "Rowan Hale", handle: "rowan", ids: { slack: "U0EXOWNER", github: "example-owner" } }),
    definePrincipal({ name: "Sarah Kim", ids: { slack: "U_SARAH" } }),
    definePrincipal({ name: "Outsider", ids: { discord: "D_X" } }),
  ],
});

const { unifiedDomainAudit } = await import("../agent/control/views.js");
const { appendAudit, readAudit } = await import("../agent/audit/audit.js");
const {
  handleUnifiedAuditRead,
  CONTROL_READ_UNIFIED_AUDIT_PATH,
} = await import("../agent/control/read-route.js");

{
  const v = await unifiedDomainAudit({ domain: "payments" });
  ok(v.unified === true, "unified true (code gate + ambient supervisor on)");
  ok(v.domain === "payments" && v.org === "acme", "domain + org echoed");
  ok(v.containers.length === 2, "both containers audited");
  ok(JSON.stringify(v.platforms) === JSON.stringify(["github", "slack"]), "platforms span the domain, sorted");

  ok(v.agentReach.reachableHosts.includes("api.example.com"), "union includes the org-wide host");
  ok(v.agentReach.reachableHosts.includes("deploy.example.com"), "union includes the github-only host");

  const gh = v.containers.find((c) => c.platform === "github")!;
  const slack = v.containers.find((c) => c.platform === "slack")!;
  ok(gh.widens.includes("host:deploy.example.com"), "the github container is flagged as WIDENING the reach (deploy host)");
  ok(!slack.widens.includes("host:deploy.example.com"), "the slack container does not widen with the github-only host");
  ok(!gh.widens.includes("host:api.example.com"), "a host granted to BOTH containers is not a widener");

  const rowan = v.humans.find((h) => h.name === "Rowan Hale")!;
  const sarah = v.humans.find((h) => h.name === "Sarah Kim")!;
  ok(!!rowan && JSON.stringify(rowan.surfacesInDomain) === JSON.stringify(["github", "slack"]), "Rowan is on both domain surfaces");
  ok(rowan.surfacesNotIn.length === 0, "Rowan is not absent from any domain surface");
  ok(!!sarah && JSON.stringify(sarah.surfacesInDomain) === JSON.stringify(["slack"]), "Sarah is on slack only");
  ok(JSON.stringify(sarah.surfacesNotIn) === JSON.stringify(["github"]), "Sarah is NOT on github — the read-across exposure (answering github could disclose to a non-member)");
  ok(!v.humans.some((h) => h.name === "Outsider"), "a principal touching no domain platform is excluded");

  ok(JSON.stringify(v.controllers) === JSON.stringify(["slack/T1/U_ADMIN"]), "controllers = domain admins, as the qualified roster keys they are stored as");
  ok(v.notes.some((nn) => nn.includes("Pure-read")), "notes state the pure-read discipline");
  ok(v.notes.some((nn) => nn.toLowerCase().includes("privacy ordinal")), "notes flag the not-yet-enforced privacy ordinal (honest)");
}

{
  let threw = false;
  try {
    await unifiedDomainAudit({ domain: "nope" });
  } catch {
    threw = true;
  }
  ok(threw, "unknown domain name throws");
}

const SECRET = "unified-audit-test-token";
const SHA = createHash("sha256").update(SECRET, "utf-8").digest("hex");
const url = (q: string) => `https://oe.example${CONTROL_READ_UNIFIED_AUDIT_PATH}${q}`;
const call = (q: string, token?: string) =>
  handleUnifiedAuditRead(new Request(url(q), { headers: token ? { authorization: `Bearer ${token}` } : {} }));

{
  ok((await call("?domain=payments", SECRET)).status === 404, "no OE_CONTROL_READ_TOKENS → 404 (mode fully off) even with a good bearer");
}
process.env.OE_CONTROL_READ_TOKENS = `e2e-harness:${SHA}`;
{
  ok((await call("?domain=payments")).status === 401, "configured + no bearer → 401");
  ok((await call("?domain=payments", "wrong")).status === 401, "configured + wrong token → 401");
  ok((await call("", SECRET)).status === 400, "missing domain → 400");
  ok((await call("?domain=nope", SECRET)).status === 400, "unknown domain → 400");
  ok((await call("?domain=payments&sinceDays=abc", SECRET)).status === 400, "bad sinceDays → 400");
  const good = await call("?domain=payments", SECRET);
  ok(good.status === 200, "good call → 200");
  const body = (await good.json()) as { domain: string; unified: boolean; containers: unknown[] };
  ok(body.domain === "payments" && body.unified === true && body.containers.length === 2, "200 body is the audit result");
  const rows = await readAudit({ org: "acme", action: "control.service_call" });
  ok(rows.some((r) => (r.detail as { view?: string })?.view === "unified_domain_audit"), "every authenticated call is self-audited (control.service_call, view=unified_domain_audit)");
}

{
  const { platformWorkspaceForWindowDomain } = await import("../agent/channels/unified.js");
  const { dmWindowKey, formatWindowToken, parseWindowToken } = await import("../agent/channels/window-key.js");

  const dmToken = formatWindowToken(dmWindowKey("slack/T1/D999", 4));
  const dmDomain = parseWindowToken(dmToken)!.domain;
  ok(dmDomain === "oe-dm/slack/T1/D999", "a DM seat's token domain IS the reserved pseudo-domain (the thing that must not be stamped)");
  ok(
    platformWorkspaceForWindowDomain(dmDomain) === "T1",
    "🔴 R3: a DM window's audit workspace is the PLATFORM workspace (T1) recovered from the surface key inside the pseudo-domain — never `oe-dm/…`",
  );
  ok(!platformWorkspaceForWindowDomain(dmDomain).includes("oe-dm"), "…and carries no trace of the pseudo-domain prefix at all");

  ok(platformWorkspaceForWindowDomain("payments") === "payments", "a real config domain still labels as itself (byte-identical to before)");
  ok(platformWorkspaceForWindowDomain("oe-dm/") === "oe-dm/", "a malformed anchor fails SOFT to the domain string — an odd label beats a thrown audit row");
  ok(platformWorkspaceForWindowDomain("oe-dm/slack") === "oe-dm/slack", "…same for an anchor with no workspace segment");
}

void appendAudit;

console.log(`✓ unified-audit: ${passed} assertions passed (composition view: containers/reach-union/wideners/humans-read-across/controllers/notes + route: 404/401/400/200/self-audit)`);
