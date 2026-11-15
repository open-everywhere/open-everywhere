// proves: browser.personal.open, browser.personal.action, browser.personal.act_granted, browser.personal.takeover, browser.personal.handback, browser.personal.view_opened, browser.personal.closed, browser.personal.forget

import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SQLITE_DIR = mkdtempSync(join(tmpdir(), "oe-personal-browser-"));
delete process.env.DATABASE_URL;
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(SQLITE_DIR, "pb.sqlite3");

const policyMod = await import("../agent/personal-browser/policy.js");
const lifecycle = await import("../agent/personal-browser/lifecycle.js");
const storeMod = await import("../agent/personal-browser/store.js");
const boxClient = await import("../agent/personal-browser/box-client.js");
const viewer = await import("../agent/personal-browser/viewer.js");
const approvals = await import("../agent/approvals/personal-browser.js");
const { actionKind: getActionKind } = await import("../agent/approvals/actions.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { isRuntimeUsageKind } = await import("../agent/spend/usage-events.js");
const { overrideSettingsForTest, resetSettingsForTest } = await import("../agent/settings/settings.js");
const { mintPageToken, verifyPageToken } = await import("../agent/credentials/page-token.js");
const { encryptedKvVault } = await import("../agent/credentials/kv-vault.js");
import type { BoxListing, BoxSpec, LongLivedBoxBackend } from "../agent/sandbox/long-lived-box.js";
import type { PersonalBrowserPolicy } from "../agent/personal-browser/policy.js";
import type { BrowserOwner } from "../agent/personal-browser/lifecycle.js";
import type { BoxTransport } from "../agent/personal-browser/box-client.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}
async function rejects(fn: () => Promise<unknown>, needle: string, label: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    ok(String(err).includes(needle), `${label} (message mentions "${needle}", got: ${String(err)})`);
    return;
  }
  ok(false, `${label} (did not throw)`);
}

const ORG = "acme";
const ON: PersonalBrowserPolicy = { ...policyMod.DEFAULT_PERSONAL_BROWSER_POLICY, enabled: true, box: { image: "oe-personal-browser:1", vcpus: 2, memoryMb: 4096 } };

{
  ok(policyMod.DEFAULT_PERSONAL_BROWSER_POLICY.enabled === false, "the shipped default is OFF");
  ok(policyMod.personalBrowserPolicy().enabled === false, "with no registration the browser is off");
  ok(policyMod.personalBrowserPolicyProblems(ON).length === 0, "a sane enabled policy has no problems");
  for (const [bad, label] of [
    [{ ...ON, sessionMinutes: 24 * 60 + 1 }, "a session cap over 24 h"],
    [{ ...ON, idleMinutes: 2 }, "an idle window under 5 minutes"],
    [{ ...ON, keepLoginsDays: 0 }, "zero days of logins"],
    [{ ...ON, keepLoginsDays: 91 }, "over 90 days of logins"],
    [{ ...ON, box: { ...ON.box, image: "has space" } }, "an image name with a space"],
    [{ ...ON, box: { ...ON.box, dockerNetwork: "bad network!" } }, "a docker network name with punctuation"],
    [{ ...ON, idleMinutes: 200, sessionMinutes: 100 }, "an idle window longer than the session cap"],
    [{ ...ON, actGrantMinutes: 0 }, "a zero-minute act grant"],
  ] as const) {
    ok(policyMod.personalBrowserPolicyProblems(bad as PersonalBrowserPolicy).length > 0, `the policy refuses ${label}`);
  }
  let threw = false;
  try {
    policyMod.registerPersonalBrowserPolicy({ ...ON, takeoverMinutes: -1 });
  } catch {
    threw = true;
  }
  ok(threw && policyMod.personalBrowserPolicy().enabled === false, "a bad policy fails the boot and leaves the browser OFF");

  const ask = { mode: "dm" as const, trust: "internal" as const, nonMember: false, actingPrincipal: "U1" };
  ok(policyMod.personalBrowserRefusal(ON, ask) === undefined, "the person's own internal DM, a member's wake and a present person may use it");
  ok(/not enabled/.test(policyMod.personalBrowserRefusal(policyMod.DEFAULT_PERSONAL_BROWSER_POLICY, ask) ?? ""), "OFF refuses");
  ok(/only works in your direct message/.test(policyMod.personalBrowserRefusal(ON, { ...ask, mode: "channel" }) ?? ""), "🔴 a channel refuses — no room borrows a person's browser");
  ok(/only works in your direct message/.test(policyMod.personalBrowserRefusal(ON, { ...ask, mode: "mpim" }) ?? ""), "🔴 a group DM refuses");
  ok(/not confirmed internal/.test(policyMod.personalBrowserRefusal(ON, { ...ask, trust: "external" }) ?? ""), "🔴 a guest or outside DM partner refuses (the strictest default)");
  ok(/outside the workspace woke/.test(policyMod.personalBrowserRefusal(ON, { ...ask, nonMember: true }) ?? ""), "a non-member wake refuses");
  ok(/needs you in the conversation/.test(policyMod.personalBrowserRefusal(ON, { ...ask, actingPrincipal: undefined }) ?? ""), "a routine fire with no person refuses");
}

{
  ok(lifecycle.browserHosts("allow-all") === "all", "allow-all is the catch-all");
  ok(Array.isArray(lifecycle.browserHosts("deny-all")) && (lifecycle.browserHosts("deny-all") as string[]).length === 0, "deny-all reaches nothing");
  const record = lifecycle.browserHosts({ allow: { "Mail.Example.com": [{ transform: [{ headers: { authorization: "Bearer org-secret" } }] }], "*.docs.example": [] } } as never);
  ok(JSON.stringify(record) === JSON.stringify(["*.docs.example", "mail.example.com"]), "🔴 the record form keeps the host names only (lower-cased, sorted) — the credential transform is dropped");
  ok(lifecycle.browserHosts({ allow: ["a.example", "b.example"] } as never) !== "all", "the list form keeps its hosts");
  ok(lifecycle.browserHosts({ allow: { "*": [], "a.example": [] } } as never) === "all", "a `*` entry is the catch-all");

  const owner = { org: ORG, person: "slack/T1/U1" };
  const k1 = lifecycle.persistKeyFor(ORG, "slack/T1/U1");
  ok(k1 === lifecycle.persistKeyFor(ORG, "slack/T1/U1") && k1 !== lifecycle.persistKeyFor(ORG, "slack/T1/U2") && k1 !== lifecycle.persistKeyFor("other", "slack/T1/U1"), "the persistence key is stable per (org, person) and distinct across both");
  ok(!k1.includes("U1") && /^oe-pb-[0-9a-f]{24}$/.test(k1), "🔴 the persistence key carries no person id");
  const spec = lifecycle.browserBoxSpec(owner, ON, ["mail.example.com"], "k".repeat(64), true);
  ok(spec.purpose === "browser" && spec.ref === k1 && spec.persist?.key === k1 && spec.port === lifecycle.BROWSER_BOX_PORT, "a persistent, port-serving `browser` box keyed and labelled by the hash");
  ok(JSON.stringify(spec.egress) === JSON.stringify({ allow: ["mail.example.com"] }), "an enforcing backend gets the host list at its firewall");
  ok(spec.env.OE_PB_KEY === "k".repeat(64) && spec.env.OE_PB_ALLOW === JSON.stringify(["mail.example.com"]), "the per-open key and the in-browser fence list reach the box through its env");
  ok(lifecycle.browserBoxSpec(owner, ON, ["mail.example.com"], "k", false).egress === "open", "a non-enforcing backend runs the box open (the caller has checked the unenforced posture)");
  ok(lifecycle.browserBoxSpec(owner, ON, "all", "k", true).egress === "open" && lifecycle.browserBoxSpec(owner, ON, "all", "k", true).env.OE_PB_ALLOW === '["*"]', "a catch-all declaration is open egress with a `*` fence");
  ok(!JSON.stringify(spec).includes("slack/T1/U1"), "🔴 the spec names no person anywhere");
  ok(spec.maxMinutes === ON.sessionMinutes && spec.persist?.keepDays === ON.keepLoginsDays, "the session cap and the login lifetime come from the policy");
}

{
  const h = boxClient.boxAuthHeader("key", "POST", "/cmd", "{}", 1234);
  ok(/^1234\.[0-9a-f]{64}$/.test(h), "the auth header is `<ts>.<hex HMAC>`");
  ok(h !== boxClient.boxAuthHeader("key", "POST", "/cmd", '{"op":"go"}', 1234) && h !== boxClient.boxAuthHeader("other", "POST", "/cmd", "{}", 1234) && h !== boxClient.boxAuthHeader("key", "GET", "/cmd", "{}", 1234), "the signature covers the key, the method, the path and the body");
  ok(boxClient.mintBoxKey() !== boxClient.mintBoxKey() && /^[0-9a-f]{64}$/.test(boxClient.mintBoxKey()), "each open mints a fresh 32-byte key");
}

interface FakeBox {
  key: string;
  url: string;
  page: string;
  alive: boolean;
  cmds: Record<string, unknown>[];
  inputs: Record<string, unknown>[];
  shutdown: number;
  locks: string[];
}
const boxes = new Map<string, FakeBox>();
let badSignatures = 0;
let boxSeq = 0;

const transport: BoxTransport = async (req) => {
  const base = [...boxes.values()].find((b) => req.url.startsWith(`${b.url}/`));
  if (base === undefined || !base.alive) throw new Error("connect ECONNREFUSED");
  const path = req.url.slice(base.url.length);
  const header = req.headers["x-oe-box-auth"] ?? "";
  const ts = Number(header.split(".")[0]);
  if (header !== boxClient.boxAuthHeader(base.key, req.method, path, req.body ?? "", ts)) {
    badSignatures++;
    return { status: 401, json: { ok: false } };
  }
  if (path === "/health") return { status: 200, json: { ok: true, url: base.page, title: "Inbox" } };
  if (path === "/frame") return { status: 200, bytes: new Uint8Array([0xff, 0xd8, 0xff]) };
  const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
  if (path === "/shutdown") {
    base.shutdown++;
    return { status: 200, json: { ok: true } };
  }
  if (path === "/lock") {
    base.locks.push(String((JSON.parse(req.body ?? "{}") as Record<string, unknown>)["holder"]));
    return { status: 200, json: { ok: true } };
  }
  if (path === "/input") {
    base.inputs.push(body);
    return { status: 200, json: { ok: true, url: base.page } };
  }
  if (path === "/cmd") {
    base.cmds.push(body);
    if (body["op"] === "go") base.page = String(body["url"]);
    if (body["op"] === "look") return { status: 200, json: { ok: true, url: base.page, title: "Inbox", text: "3 messages", elements: [{ ref: "e1", role: "button", name: "Send" }] } };
    return { status: 200, json: { ok: true, url: base.page, title: "Inbox" } };
  }
  return { status: 404, json: { ok: false } };
};
boxClient.setBoxTransportForTest(transport);

function fakeBackend(enforce = true): LongLivedBoxBackend & { opened: BoxSpec[]; stopped: string[]; forgotten: string[]; live: Map<string, BoxListing> } {
  const opened: BoxSpec[] = [];
  const stopped: string[] = [];
  const forgotten: string[] = [];
  const live = new Map<string, BoxListing>();
  return {
    backend: enforce ? "vercel" : "docker",
    metered: enforce,
    maxMinutesCeiling: 24 * 60,
    enforcesHostAllowList: enforce,
    opened,
    stopped,
    forgotten,
    live,
    async open(spec) {
      opened.push(spec);
      const name = `${spec.persist!.key}-${opened.length}`;
      const url = `https://box-${++boxSeq}.example`;
      boxes.set(url, { key: spec.env.OE_PB_KEY!, url, page: "about:blank", alive: true, cmds: [], inputs: [], shutdown: 0, locks: [] });
      live.set(name, { name, status: "running", createdAt: Date.now(), purpose: "browser", ref: spec.ref });
      return { name, backend: this.backend, createdAt: Date.now(), maxMinutes: spec.maxMinutes, url };
    },
    async status(name) {
      return live.get(name);
    },
    async list() {
      return [...live.values()];
    },
    async stop(name) {
      stopped.push(name);
      live.delete(name);
    },
    async forget(key) {
      forgotten.push(key);
    },
  };
}

function ownerFor(id: string): BrowserOwner {
  return {
    org: ORG,
    person: `slack/T1/${id}`,
    principalId: id,
    platform: "slack",
    dmChannelId: `D-${id}`,
    partition: { org: ORG, platform: "slack", workspace: "T1", surface: `D-${id}`, workspaceKey: "slack/T1", surfaceKey: `slack/T1/D-${id}`, key: `slack/T1/D-${id}` },
  };
}

async function audit(): Promise<{ action: string; principalId?: string; detail?: Record<string, unknown> }[]> {
  return (await getOperationalStore().readAudit({ org: ORG, limit: 1000 } as never)) as unknown as { action: string; principalId?: string; detail?: Record<string, unknown> }[];
}
const deps = (backend: LongLivedBoxBackend, extra: Record<string, unknown> = {}) => ({ backend, policy: ON, healthWaitMs: 200, ...extra });

{
  const store = getOperationalStore();
  ok((await store.getPersonalBrowser(ORG, "slack/T1/Z")) === null, "no row before the first write");
  ok((await store.casPersonalBrowser(ORG, "slack/T1/Z", "{}", new Date().toISOString(), null)) === 1, "the first write creates version 1");
  ok((await store.casPersonalBrowser(ORG, "slack/T1/Z", "{}", new Date().toISOString(), null)) === null, "a second first write loses");
  ok((await store.casPersonalBrowser(ORG, "slack/T1/Z", '{"a":1}', new Date().toISOString(), 1)) === 2, "a write at the current version wins and bumps it");
  ok((await store.casPersonalBrowser(ORG, "slack/T1/Z", '{"a":2}', new Date().toISOString(), 1)) === null, "🔴 a write at a stale version loses — one winner per race");
  ok((await store.getPersonalBrowser("other-org", "slack/T1/Z")) === null, "another org sees no row");
  ok((await store.deletePersonalBrowser(ORG, "slack/T1/Z")) === true && (await store.getPersonalBrowser(ORG, "slack/T1/Z")) === null, "delete removes the row");
}

const backend = fakeBackend(true);
const ana = ownerFor("UANA");
{
  await rejects(() => lifecycle.ensureBrowserOpen(ana, ["mail.example.com"], { ...deps(backend), policy: policyMod.DEFAULT_PERSONAL_BROWSER_POLICY }), "turned off", "an open while the browser is off refuses");
  await rejects(() => lifecycle.ensureBrowserOpen(ana, [], deps(backend)), "admits no host", "a declaration that admits no host refuses before any box opens");
  ok(backend.opened.length === 0, "…and no box opened");

  const first = await lifecycle.ensureBrowserOpen(ana, ["mail.example.com"], deps(backend));
  ok(first.started && backend.opened.length === 1 && first.state.box.url === "https://box-1.example", "the first open starts a box and records its URL");
  ok(first.state.box.egressEnforced === true && first.state.lock.holder === "agent", "on an enforcing backend the firewall holds the list, and the agent holds the controls");
  const again = await lifecycle.ensureBrowserOpen(ana, ["mail.example.com"], deps(backend));
  ok(!again.started && backend.opened.length === 1 && again.state.box.name === first.state.box.name, "a second open reuses the live box");
  const openRows = (await audit()).filter((r) => r.action === "browser.personal.open");
  ok(openRows.length === 1 && openRows[0]!.principalId === "UANA" && openRows[0]!.detail?.["hosts"] === 1 && openRows[0]!.detail?.["egressEnforced"] === true, "ONE browser.personal.open row names the person, the host count and the firewall");
  ok(!JSON.stringify(openRows).includes(first.state.box.key), "🔴 the open row never carries the box key");

  boxes.get(first.state.box.url)!.alive = false;
  const replaced = await lifecycle.ensureBrowserOpen(ana, ["mail.example.com"], deps(backend));
  ok(replaced.started && backend.opened.length === 2 && backend.stopped.includes(first.state.box.name), "a box that stopped answering is closed and a fresh one opens");
  ok(backend.opened[1]!.persist?.key === backend.opened[0]!.persist?.key, "…on the SAME persistence key, so the logins carry over");
  ok(replaced.state.box.key !== first.state.box.key, "…with a fresh per-open key");

  const bob = ownerFor("UBOB");
  await storeMod.updatePersonalBrowser(ORG, bob.person, () => ({
    next: { v: 1, org: ORG, person: bob.person, principalId: "UBOB", platform: "slack", dm: { channelId: bob.dmChannelId }, partition: bob.partition, persistKey: lifecycle.persistKeyFor(ORG, bob.person), lock: { holder: "agent", since: Date.now() }, acts: {}, links: {}, sessions: {}, opening: Date.now() },
    result: undefined,
  }));
  const opensBefore = backend.opened.length;
  await rejects(() => lifecycle.ensureBrowserOpen(bob, ["mail.example.com"], { ...deps(backend), healthWaitMs: 0, now: (() => { let t = Date.now(); return () => (t += 30_000); })() }), "still starting", "🔴 a second open while one is in flight never opens a second box — it waits, then refuses if the first never lands");
  ok(backend.opened.length === opensBefore, "…and no second box opened on the profile");
  const dee = ownerFor("UDEE");
  const [p1, p2, p3] = await Promise.all([1, 2, 3].map(() => lifecycle.ensureBrowserOpen(dee, ["mail.example.com"], deps(backend))));
  ok(p1.state.box.name === p2.state.box.name && p2.state.box.name === p3.state.box.name && [p1, p2, p3].filter((r) => r.started).length === 1, "🔴 three parallel opens share ONE box, started once");

  const eve = ownerFor("UEVE");
  const slow = fakeBackend(true);
  const realOpen = slow.open.bind(slow);
  slow.open = async (spec) => {
    const opened = await realOpen(spec);
    await storeMod.updatePersonalBrowser(ORG, eve.person, (cur) => ({ next: { ...cur!, opening: 1 }, result: undefined }));
    return opened;
  };
  await rejects(() => lifecycle.ensureBrowserOpen(eve, ["mail.example.com"], deps(slow)), "took over opening", "🔴 an open whose claim was taken over refuses");
  ok(slow.stopped.length === 1 && (await storeMod.getPersonalBrowserState(ORG, eve.person))!.state.box === undefined && (await storeMod.getPersonalBrowserState(ORG, eve.person))!.state.opening === 1, "…stops its own box, and leaves the other open's claim alone");

  const fay = ownerFor("UFAY");
  const named = fakeBackend(true);
  const namedOpen = named.open.bind(named);
  named.open = async (spec) => {
    const opened = await namedOpen(spec);
    const asVercel = { ...opened, name: spec.persist!.key };
    await storeMod.updatePersonalBrowser(ORG, fay.person, (cur) => ({
      next: { ...cur!, opening: undefined, box: { name: spec.persist!.key, backend: "vercel", metered: true, url: opened.url!, key: spec.env.OE_PB_KEY!, createdAt: Date.now(), maxMinutes: 60, memoryMb: 4096, egressEnforced: true } },
      result: undefined,
    }));
    return asVercel;
  };
  const shared = await lifecycle.ensureBrowserOpen(fay, ["mail.example.com"], deps(named));
  ok(!shared.started && shared.state.box.name === lifecycle.persistKeyFor(ORG, fay.person) && named.stopped.length === 0, "🔴 a slow open whose box shares its name with the recorded winner never stops that box");

  const gil = ownerFor("UGIL");
  const badBefore = badSignatures;
  const sick = fakeBackend(true);
  const sickOpen = sick.open.bind(sick);
  sick.open = async (spec) => {
    const opened = await sickOpen(spec);
    boxes.get(opened.url!)!.key = "another-open's-key";
    await storeMod.updatePersonalBrowser(ORG, gil.person, (cur) => ({ next: { ...cur!, opening: 7 }, result: undefined }));
    return { ...opened, name: spec.persist!.key };
  };
  await rejects(() => lifecycle.ensureBrowserOpen(gil, ["mail.example.com"], { ...deps(sick), healthWaitMs: 50 }), "left that box running", "🔴 a slow open whose health check meets another open's box says it left the box running");
  ok(sick.stopped.length === 0 && (await storeMod.getPersonalBrowserState(ORG, gil.person))!.state.opening === 7, "…stops nothing, and leaves the other open's claim");
  badSignatures = badBefore;

  const docker = fakeBackend(false);
  const cy = ownerFor("UCY");
  await rejects(() => lifecycle.ensureBrowserOpen(cy, ["mail.example.com"], deps(docker)), "cannot enforce a host list", "🔴 a backend with no host firewall refuses without the declared unenforced posture");
  ok(docker.opened.length === 0, "…and opens nothing");
  await rejects(() => lifecycle.ensureBrowserOpen(ownerFor("UALL"), "all", deps(docker)), "cannot enforce a host list", "🔴 a catch-all declaration on a backend with no host firewall still needs the declared unenforced posture");
  overrideSettingsForTest({ egress: { allowUnenforced: true } } as never);
  const unenforced = await lifecycle.ensureBrowserOpen(cy, ["mail.example.com"], deps(docker));
  ok(docker.opened[0]!.egress === "open" && docker.opened[0]!.env.OE_PB_ALLOW === '["mail.example.com"]' && unenforced.state.box.egressEnforced === false, "under `egress.allowUnenforced` the box runs open, the in-browser fence holds the list, and the row says it is not enforced");
  resetSettingsForTest();
  await lifecycle.closeBrowser(ORG, cy.person, "closed", deps(docker));
}

{
  const live = (await storeMod.getPersonalBrowserState(ORG, ana.person))!.state;
  const box = boxes.get(live.box!.url)!;
  const s = { ...live, box: live.box! };
  const went = await lifecycle.actOnBrowser(s, "go", { url: "https://mail.example.com/inbox" }, deps(backend));
  ok(went.kind === "done" && box.page === "https://mail.example.com/inbox", "a read (go) reaches the box");
  const looked = await lifecycle.actOnBrowser(s, "look", {}, deps(backend));
  ok(looked.kind === "done" && looked.page["text"] === "3 messages", "a look returns the page");
  const needs = await lifecycle.actOnBrowser(s, "click", { ref: "e1" }, deps(backend));
  ok(needs.kind === "needs-approval" && needs.host === "mail.example.com", "🔴 a click on a site the person has not approved needs their card, for that host");
  ok(!box.cmds.some((c) => c["op"] === "click"), "…and nothing was clicked");
  const typed = await lifecycle.actOnBrowser(s, "type", { ref: "e1", text: "hello secret words" }, deps(backend));
  ok(typed.kind === "needs-approval", "a keystroke needs the same card");

  const actKind = getActionKind("browser.personal.act")!;
  const handbackKind = getActionKind("browser.personal.handback")!;
  ok(actKind.policy === "member" && handbackKind.policy === "member", "both cards are member tier");
  const actArgs = { org: ORG, person: ana.person, principalId: "UANA", host: "mail.example.com", minutes: 60 };
  await rejects(() => actKind.execute(actArgs, "UMALLORY"), "only the person whose browser this is", "🔴 another member's click grants nothing");
  await rejects(() => actKind.execute(actArgs, "chain:judge"), "only the person whose browser this is", "🔴 an approver-chain lowering grants nothing");
  ok(((await storeMod.getPersonalBrowserState(ORG, ana.person))!.state.acts["mail.example.com"] ?? 0) === 0, "…so no grant was recorded");
  ok(approvals.browserActSummary(actArgs).some((l) => /password, one-time-code or card/.test(l)), "the act card says secrets stay the person's");
  await actKind.execute(actArgs, "UANA");
  const granted = (await storeMod.getPersonalBrowserState(ORG, ana.person))!.state;
  ok((granted.acts["mail.example.com"] ?? 0) > Date.now(), "the owner's own click grants acting on that host");
  const clicked = await lifecycle.actOnBrowser({ ...granted, box: granted.box! }, "type", { ref: "e1", text: "hello secret words" }, deps(backend));
  ok(clicked.kind === "done" && box.cmds.some((c) => c["op"] === "type"), "with the grant the keystroke reaches the box");
  ok(box.cmds.find((c) => c["op"] === "type")?.["expectHost"] === "mail.example.com", "🔴 the write names the approved host, so the box refuses it if the page moved to another site");
  ok(!box.cmds.some((c) => c["op"] === "go" && "expectHost" in c), "a read carries no expected host");
  const actionRows = (await audit()).filter((r) => r.action === "browser.personal.action");
  ok(actionRows.length === 3 && actionRows.every((r) => r.detail?.["host"] === "mail.example.com" && typeof r.detail?.["op"] === "string"), "each action that reached the box wrote ONE browser.personal.action row with its op and host");
  ok(!JSON.stringify(actionRows).includes("hello secret words"), "🔴 no action row carries the typed text");
  ok((await audit()).some((r) => r.action === "browser.personal.act_granted" && r.principalId === "UANA" && r.detail?.["host"] === "mail.example.com"), "the grant is audited under the owner");
  ok(!(granted.acts["other.example.com"] ?? 0), "the grant covers that host only");

  const t = await lifecycle.takeOver(ORG, ana.person, "agent", deps(backend), "sign in to your mail");
  ok(t !== undefined && t.until > Date.now(), "the agent's hand-off gives the person the controls until an expiry");
  const held = (await storeMod.getPersonalBrowserState(ORG, ana.person))!.state;
  const refused = await lifecycle.actOnBrowser({ ...held, box: held.box! }, "look", {}, deps(backend));
  ok(refused.kind === "refused" && /you have the controls/.test(refused.message), "🔴 while the person holds the controls every agent action is REFUSED, a read included");
  await rejects(() => handbackKind.execute({ org: ORG, person: ana.person, principalId: "UANA", reason: "x" }, "UMALLORY"), "only the person whose browser this is", "🔴 another member cannot hand the controls back");
  ok((await handbackKind.execute({ org: ORG, person: ana.person, principalId: "UANA", reason: "x" }, "UANA")).includes("back with the agent"), "the owner's hand-back card returns the controls");
  const back = (await storeMod.getPersonalBrowserState(ORG, ana.person))!.state;
  ok(back.lock.holder === "agent" && (await lifecycle.actOnBrowser({ ...back, box: back.box! }, "look", {}, deps(backend))).kind === "done", "…and the agent may act again");
  ok((await audit()).some((r) => r.action === "browser.personal.takeover" && r.detail?.["reason"] === "sign in to your mail") && (await audit()).some((r) => r.action === "browser.personal.handback" && r.detail?.["by"] === "card"), "take-over (with its reason) and hand-back are audited");
  ok(lifecycle.personHolds({ lock: { holder: "person", since: 0, until: Date.now() - 1 } }, Date.now()) === false, "an expired hold no longer blocks the agent");
  ok(box.locks.join(",") === "person,agent", "🔴 the take-over and the hand-back each tell the box, so the box itself refuses an agent command while the person holds the controls");

  const snapshot = (await storeMod.getPersonalBrowserState(ORG, ana.person))!.state;
  await lifecycle.takeOver(ORG, ana.person, "page", deps(backend));
  const cmdsBefore = box.cmds.length;
  const raced = await lifecycle.actOnBrowser({ ...snapshot, box: snapshot.box! }, "look", {}, deps(backend));
  ok(raced.kind === "refused" && box.cmds.length === cmdsBefore, "🔴 a take-over between the agent's check and its command still stops the command");
  await lifecycle.handBack(ORG, ana.person, "page", deps(backend));

  const staleClose = await lifecycle.closeBrowser(ORG, ana.person, "unreachable", deps(backend), undefined, (cur) => cur.box.name === "some-older-box");
  ok(!staleClose.closed && (await storeMod.getPersonalBrowserState(ORG, ana.person))!.state.box !== undefined, "🔴 a stale close (another box than the one it saw) closes nothing");
}

{
  const KEY = "a".repeat(48);
  const env = { OE_PUBLIC_BASE_URL: "https://oe.example" } as NodeJS.ProcessEnv;
  const posts: { channelId: string; text: string }[] = [];
  const vdeps = { ...deps(backend), env, post: async (_p: string, t: { channelId: string; text: string }) => (posts.push(t), "ts") };
  const savedAesKey = process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  ok((await viewer.issueWatchLink({ org: ORG, person: ana.person }, vdeps)) === undefined, "no credential vault → no page signing key → no link");
  process.env.OE_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  await encryptedKvVault().write("self:OE_INTAKE_PAGE_SIGNING_KEY", KEY);
  process.env.OE_INTAKE_PAGE_SIGNING_KEY = "b".repeat(48);
  const link = (await viewer.issueWatchLink({ org: ORG, person: ana.person }, vdeps))!;
  delete process.env.OE_INTAKE_PAGE_SIGNING_KEY;
  ok(link.url.startsWith("https://oe.example/browser/v1/view?t="), "a link names the view route under the public URL");
  const token = decodeURIComponent(new URL(link.url).searchParams.get("t")!);
  ok(verifyPageToken(token, KEY, "browser-view", Date.now()) !== null, "🔴 the link is signed with the VAULT's page key, not an env var of that name");
  const get = await viewer.handleViewGet(new Request(link.url), vdeps);
  ok(get.status === 200 && (await get.text()).includes("Open my browser"), "the link's GET renders the button page");
  ok(Object.keys((await storeMod.getPersonalBrowserState(ORG, ana.person))!.state.links).length === 1, "🔴 the GET consumed nothing (an unfurler cannot burn the link)");
  const form = (t: string) => new Request("https://oe.example/browser/v1/view", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t }).toString() });
  const opened = await viewer.handleViewPost(form(token), vdeps);
  const cookie = opened.headers.get("set-cookie") ?? "";
  ok(opened.status === 200 && /^oe_pb=/.test(cookie) && /HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie) && /Path=\/browser\/v1\//.test(cookie) && /Secure/.test(cookie), "the POST starts a session: an HttpOnly, SameSite=Strict, Secure cookie on /browser/v1/");
  ok((await viewer.handleViewPost(form(token), vdeps)).status === 404, "🔴 the link is single-use: a second POST is a 404");
  ok((await audit()).some((r) => r.action === "browser.personal.view_opened" && r.principalId === "UANA"), "the open is audited");
  const sessionToken = decodeURIComponent(cookie.split(";")[0]!.slice("oe_pb=".length));
  const withCookie = (path: string, init: RequestInit = {}, csrf = true) =>
    new Request(`https://oe.example${path}`, { ...init, headers: { cookie: `oe_pb=${encodeURIComponent(sessionToken)}`, ...(csrf ? { "x-oe-pb": "1" } : {}), "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } });

  const live = await viewer.handleLiveGet(withCookie("/browser/v1/live"), vdeps);
  const csp = live.headers.get("content-security-policy") ?? "";
  ok(live.status === 200 && /frame-ancestors 'none'/.test(csp) && /script-src 'nonce-/.test(csp) && live.headers.get("x-frame-options") === "DENY", "the live page renders with a nonce CSP and no framing");
  ok((await viewer.handleLiveGet(new Request("https://oe.example/browser/v1/live"), vdeps)).status === 404, "no cookie → 404");
  const forged = mintPageToken({ v: 1, aud: "browser-view", org: ORG, id: "x", rb: ana.person, exp: Date.now() + 60_000 }, KEY);
  ok((await viewer.handleLiveGet(new Request("https://oe.example/browser/v1/live", { headers: { cookie: `oe_pb=${encodeURIComponent(forged)}` } }), vdeps)).status === 404, "🔴 a link token offered as the session cookie is a 404 (audience wall)");
  const frame = await viewer.handleLiveFrame(withCookie("/browser/v1/live/frame"), vdeps);
  ok(frame.status === 200 && frame.headers.get("content-type") === "image/jpeg", "the frame route proxies the box's JPEG");
  const st = (await (await viewer.handleLiveState(withCookie("/browser/v1/live/state"), vdeps)).json()) as Record<string, unknown>;
  ok(st["holder"] === "agent" && st["running"] === true && typeof st["url"] === "string", "the state route names the holder and the page");

  const box = boxes.get((await storeMod.getPersonalBrowserState(ORG, ana.person))!.state.box!.url)!;
  const input = (b: unknown, csrf = true) => viewer.handleLiveInput(withCookie("/browser/v1/live/input", { method: "POST", body: JSON.stringify(b) }, csrf), vdeps);
  ok((await input({ kind: "text", text: "hunter2" })).status === 409 && box.inputs.length === 0, "🔴 input is refused while the AGENT holds the controls");
  ok((await viewer.handleLiveControl(withCookie("/browser/v1/live/control", { method: "POST", body: JSON.stringify({ action: "takeover" }) }, false), vdeps)).status === 404, "🔴 a control request without the CSRF header is a 404");
  ok((await viewer.handleLiveControl(withCookie("/browser/v1/live/control", { method: "POST", body: JSON.stringify({ action: "takeover" }) }), vdeps)).status === 200, "the person takes the controls on the page");
  ok((await input({ kind: "text", text: "hunter2" }, false)).status === 404 && box.inputs.length === 0, "🔴 input without the CSRF header is a 404");
  ok((await input({ kind: "text", text: "hunter2" })).status === 200 && box.inputs.length === 1 && box.inputs[0]!["text"] === "hunter2", "with the controls, the person's input reaches the box");
  ok((await input({ kind: "exec", cmd: "rm -rf /" })).status === 400, "an unknown input kind is refused");
  ok(!JSON.stringify(await audit()).includes("hunter2"), "🔴 the person's keystrokes are written to no audit row");
  ok((await audit()).some((r) => r.action === "browser.personal.takeover" && r.detail?.["by"] === "page"), "the page take-over is audited");
  const hb = await viewer.handleLiveControl(withCookie("/browser/v1/live/control", { method: "POST", body: JSON.stringify({ action: "handback" }) }), vdeps);
  ok(hb.status === 200 && posts.some((p) => p.channelId === ana.dmChannelId && /handed your browser back/.test(p.text)), "the page hand-back returns the controls and tells the person's DM");
  ok((await input({ kind: "text", text: "more" })).status === 409, "…and input is refused again");
  if (savedAesKey === undefined) delete process.env.OE_CREDENTIAL_ENCRYPTION_KEY;
  else process.env.OE_CREDENTIAL_ENCRYPTION_KEY = savedAesKey;
}

{
  const before = (await storeMod.getPersonalBrowserState(ORG, ana.person))!.state;
  const box = boxes.get(before.box!.url)!;
  const [a, b] = await Promise.all([lifecycle.closeBrowser(ORG, ana.person, "closed", deps(backend)), lifecycle.closeBrowser(ORG, ana.person, "idle", deps(backend))]);
  ok([a, b].filter((r) => r.closed).length === 1, "🔴 two racing closes: exactly one closes and bills");
  ok(box.shutdown === 1 && backend.stopped.includes(before.box!.name), "the close shut Chromium cleanly, then stopped the box");
  const usage = await getOperationalStore().usageForSession(ORG, `browser:${before.box!.name}:${before.box!.createdAt}`);
  ok(usage.length === 1 && usage[0]!.kind === "browser" && typeof usage[0]!.detail?.["browserHours"] === "number", "ONE `browser` usage event carries the box hours");
  ok(isRuntimeUsageKind("browser"), "browser rows are runtime rows to every token report");
  const after = (await storeMod.getPersonalBrowserState(ORG, ana.person))!.state;
  ok(after.box === undefined && after.lock.holder === "agent" && (after.acts["mail.example.com"] ?? 0) > 0, "the row keeps the person (and their act grants) with no box");
  ok((await audit()).filter((r) => r.action === "browser.personal.closed").some((r) => typeof r.detail?.["seconds"] === "number"), "the close is audited with its seconds");

  const forgot = await lifecycle.forgetBrowser(ORG, ana.person, deps(backend), "UANA");
  ok(forgot.existed && backend.forgotten.includes(lifecycle.persistKeyFor(ORG, ana.person)) && (await storeMod.getPersonalBrowserState(ORG, ana.person)) === undefined, "forget deletes the backend's profile and the person's row");
  ok((await audit()).some((r) => r.action === "browser.personal.forget"), "the forget is audited");

  const sweepBackend = fakeBackend(true);
  const idle = ownerFor("UIDLE");
  const holder = ownerFor("UHOLD");
  const capped = ownerFor("UCAP");
  const halted = ownerFor("UHALT");
  for (const o of [idle, holder, capped, halted]) await lifecycle.ensureBrowserOpen(o, ["mail.example.com"], deps(sweepBackend));
  await lifecycle.takeOver(ORG, holder.person, "page", deps(sweepBackend));
  sweepBackend.live.set("orphan-box", { name: "orphan-box", status: "running", createdAt: Date.now(), purpose: "browser", ref: "oe-pb-000000000000000000000000" });
  const later = Date.now() + (ON.idleMinutes + 1) * 60_000;
  await storeMod.updatePersonalBrowser(ORG, capped.person, (cur) => ({ next: { ...cur!, box: { ...cur!.box!, createdAt: later - (ON.sessionMinutes + 20) * 60_000 } }, result: undefined }));
  const swept = await lifecycle.sweepPersonalBrowsers(ORG, { ...deps(sweepBackend), now: () => later, halted: async (s) => s.person === halted.person });
  ok((await storeMod.getPersonalBrowserState(ORG, idle.person))!.state.box === undefined, "the sweep closes an idle box");
  ok((await storeMod.getPersonalBrowserState(ORG, holder.person))!.state.box !== undefined, "🔴 the sweep spares a box the person is holding");
  ok((await storeMod.getPersonalBrowserState(ORG, capped.person))!.state.box === undefined && (await audit()).some((r) => r.action === "browser.personal.closed" && r.detail?.["reason"] === "cap"), "the sweep closes a box past its cap");
  ok((await storeMod.getPersonalBrowserState(ORG, halted.person))!.state.box === undefined && (await audit()).some((r) => r.action === "browser.personal.closed" && r.detail?.["reason"] === "halted"), "the sweep closes a box under a HALT");
  ok(swept.stopped.includes("orphan-box") && !swept.stopped.some((n) => n.startsWith(lifecycle.persistKeyFor(ORG, holder.person))), "the sweep stops a live box no row accounts for, and only that one");
  const muchLater = later + (ON.takeoverMinutes + 1) * 60_000;
  const swept2 = await lifecycle.sweepPersonalBrowsers(ORG, { ...deps(sweepBackend), now: () => muchLater, halted: async () => false });
  ok(swept2.returned.length === 1 && (await audit()).some((r) => r.action === "browser.personal.handback" && r.detail?.["by"] === "expired"), "an expired take-over returns the controls to the agent");
  ok((await storeMod.getPersonalBrowserState(ORG, holder.person))!.state.box !== undefined, "🔴 the hand-back counts as use, so the same tick does not close the box the person just left");
  await lifecycle.sweepPersonalBrowsers(ORG, { ...deps(sweepBackend), now: () => muchLater + (ON.idleMinutes + 1) * 60_000, halted: async () => false });
  ok((await storeMod.getPersonalBrowserState(ORG, holder.person))!.state.box === undefined, "…and a later tick closes it once it is idle");
  ok(badSignatures === 0, "every box request in this run carried a valid signature");
}

console.log(`✓ personal-browser-test: ${passed} assertions`);
process.exit(0);
