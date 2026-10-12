// proves: browser.personal.teach

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SQLITE_DIR = mkdtempSync(join(tmpdir(), "oe-personal-browser-teach-"));
delete process.env.DATABASE_URL;
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(SQLITE_DIR, "pbt.sqlite3");

const policyMod = await import("../agent/personal-browser/policy.js");
const lifecycle = await import("../agent/personal-browser/lifecycle.js");
const storeMod = await import("../agent/personal-browser/store.js");
const boxClient = await import("../agent/personal-browser/box-client.js");
const teach = await import("../agent/personal-browser/teach.js");
await import("../agent/approvals/personal-browser.js");
const { actionKind: getActionKind } = await import("../agent/approvals/actions.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { skillProposalName, SKILL_PROPOSAL_PR_ACTION } = await import("../agent/memory/dream/skill-proposal-pr.js");
import type { BoxListing, BoxSpec, LongLivedBoxBackend } from "../agent/sandbox/long-lived-box.js";
import type { PersonalBrowserPolicy } from "../agent/personal-browser/policy.js";
import type { BrowserOwner } from "../agent/personal-browser/lifecycle.js";
import type { BoxTransport } from "../agent/personal-browser/box-client.js";
import type { ConfigPrProvider } from "../agent/credentials/config-pr.js";
import type { TaughtStep } from "../agent/personal-browser/store.js";

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

const RECORDED: unknown[] = [
  { kind: "go", url: "https://shop.example/home?session=s3cr3t" },
  { kind: "click", role: "link", name: "Your orders" },
  { kind: "arrive", url: "https://shop.example/orders", title: "Orders" },
  { kind: "type", role: "textbox", name: "Search orders" },
  { kind: "type", role: "textbox", name: "Password", secret: true },
  { kind: "key", key: "Enter" },
  { kind: "key", key: "rm -rf" },
  { kind: "exfiltrate", url: "https://evil.example" },
  { kind: "click", role: "button", name: "Cancel `order` <b>now</b>" },
];

interface FakeBox {
  key: string;
  url: string;
  page: string;
  alive: boolean;
  cmds: Record<string, unknown>[];
  teach: string[];
  teachOk: boolean;
  recording: boolean;
  stopDelayMs: number;
  present: Set<string>;
}
const boxes = new Map<string, FakeBox>();
let boxSeq = 0;

const transport: BoxTransport = async (req) => {
  const base = [...boxes.values()].find((b) => req.url.startsWith(`${b.url}/`));
  if (base === undefined || !base.alive) throw new Error("connect ECONNREFUSED");
  const path = req.url.slice(base.url.length);
  const header = req.headers["x-oe-box-auth"] ?? "";
  const ts = Number(header.split(".")[0]);
  if (header !== boxClient.boxAuthHeader(base.key, req.method, path, req.body ?? "", ts)) return { status: 401, json: { ok: false } };
  if (path === "/health") return { status: 200, json: { ok: true, url: base.page, title: "Shop" } };
  const body = JSON.parse(req.body ?? "{}") as Record<string, unknown>;
  if (path === "/lock" || path === "/shutdown") return { status: 200, json: { ok: true } };
  if (path === "/teach") {
    base.teach.push(String(body["action"]));
    if (!base.teachOk) return { status: 200, json: { ok: false, code: "bad-teach" } };
    if (body["action"] === "start") {
      base.recording = true;
      return { status: 200, json: { ok: true, recording: true } };
    }
    if (!base.recording) return { status: 200, json: { ok: true, recording: false, none: true, steps: [], capped: false, seconds: 0 } };
    base.recording = false;
    if (base.stopDelayMs > 0) await new Promise((r) => setTimeout(r, base.stopDelayMs));
    return { status: 200, json: { ok: true, recording: false, steps: RECORDED, capped: false, seconds: 95 } };
  }
  if (path === "/cmd") {
    base.cmds.push(body);
    if (body["op"] === "go") base.page = String(body["url"]);
    if (body["op"] === "find") return { status: 200, json: { ok: true, url: base.page, found: base.present.has(String(body["name"])) ? "e3" : null } };
    return { status: 200, json: { ok: true, url: base.page, title: "Shop" } };
  }
  return { status: 404, json: { ok: false } };
};
boxClient.setBoxTransportForTest(transport);

function fakeBackend(reuseName = false): LongLivedBoxBackend & { opened: BoxSpec[] } {
  const opened: BoxSpec[] = [];
  const live = new Map<string, BoxListing>();
  return {
    backend: "vercel",
    metered: true,
    maxMinutesCeiling: 24 * 60,
    enforcesHostAllowList: true,
    opened,
    async open(spec) {
      opened.push(spec);
      const name = reuseName ? spec.persist!.key : `${spec.persist!.key}-${opened.length}`;
      const url = `https://box-${++boxSeq}.example`;
      boxes.set(url, { key: spec.env.OE_PB_KEY!, url, page: "https://shop.example/home", alive: true, cmds: [], teach: [], teachOk: true, recording: false, stopDelayMs: 0, present: new Set(["Your orders", "Search orders"]) });
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
      live.delete(name);
    },
    async forget() {},
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
const backend = fakeBackend();
const deps = { backend, policy: ON, healthWaitMs: 200 };
async function stateOf(o: BrowserOwner) {
  return (await storeMod.getPersonalBrowserState(ORG, o.person))!.state;
}
const boxOf = async (o: BrowserOwner): Promise<FakeBox> => boxes.get((await stateOf(o)).box!.url)!;

const steps = teach.sanitizeTaughtSteps(RECORDED);
{
  ok(steps.length === 7, `an unknown kind and an unknown key are dropped (got ${steps.length} steps)`);
  ok(JSON.stringify(steps[0]) === JSON.stringify({ kind: "go", url: "https://shop.example/home" }), "🔴 a query string that reached the app is dropped again");
  ok(steps.every((x) => !("title" in x)) && !JSON.stringify(steps).includes("Orders\""), "🔴 an arrival keeps no page title, even when the box sends one");
  ok(!JSON.stringify(steps).includes("evil.example") && !JSON.stringify(steps).includes("rm -rf"), "nothing the box did not record as a known step survives");
  ok(teach.sanitizeTaughtSteps("junk").length === 0 && teach.sanitizeTaughtSteps([{ kind: "go", url: "javascript:alert(1)" }]).length === 0, "a non-list and a non-http address give no steps");
  ok(teach.sanitizeTaughtSteps([{ kind: "click", role: "link", name: "x".repeat(500) }])[0]!.kind === "click" && (teach.sanitizeTaughtSteps([{ kind: "click", role: "link", name: "x".repeat(500) }])[0] as { name: string }).name.length === 80, "a label is capped at 80 characters");

  const md = teach.renderTaughtSkill({ name: "cancel-order", goal: 'Cancel an "order"\non the shop', createdAt: Date.UTC(2026, 9, 12), steps, capped: false });
  ok(skillProposalName(md) === "cancel-order", "the frontmatter name is the name the skill-proposal path reads");
  ok(/^description: ".*DRAFT/m.test(md) && !/description: .*\n.*on the shop"/.test(md), "the description is one quoted line");
  ok(md.includes('Click the link "Your orders".') && md.includes('Click the button "Cancel \'order\' <b>now</b>".'), "🔴 each label is quoted as data, with no backtick left in it");
  ok(md.includes("You should now be on `https://shop.example/orders`"), "an arrival names the page the step leads to");
  ok(/Type into the field "Search orders"\. \*\*GAP:\*\* what to type here/.test(md), "a typed field is a GAP: the demonstration does not record typed text");
  ok(md.includes('The person types into the secret field "Password" themselves'), "🔴 a secret field stays the person's, with a hand-off");
  ok(md.includes("## Decision rules") && md.includes("## Failure handling") && md.includes("## Inputs"), "the decision rules, failure handling and inputs sections are present");
  const gaps = (md.match(/\*\*GAP:\*\*/g) ?? []).length;
  ok(gaps === teach.taughtGapCount({ steps }) && gaps === 4, `the GAP count the pull request states matches the file (${gaps})`);
  ok(teach.renderTaughtSkill({ name: "x", goal: "x", createdAt: 0, steps, capped: true }).includes("stopped at its cap"), "a capped recording says the last steps may be missing");
  ok(teach.renderTaughtSkill({ name: "x", goal: "x", createdAt: 0, steps: [], capped: false }).includes("recorded no steps"), "an empty recording says so");
  ok(teach.teachNameProblem("file-expense.v2") === undefined && teach.teachNameProblem("../etc") !== undefined && teach.teachNameProblem("has space") !== undefined && teach.teachNameProblem("x".repeat(65)) !== undefined, "a skill name is a safe path segment of at most 64 characters");
}

const ana = ownerFor("UANA");
{
  await rejects(() => teach.startTeaching(ORG, ana.person, { name: "cancel-order", goal: "Cancel an order" }), "not running", "a recording needs a live box");
  await lifecycle.ensureBrowserOpen(ana, ["shop.example"], deps);
  await rejects(() => teach.startTeaching(ORG, ana.person, { name: "../escape", goal: "x" }), "skill name", "🔴 a name that is not a safe path refuses before any recording");
  ok((await boxOf(ana)).teach.length === 0, "…and the box was never asked to record");

  const started = await teach.startTeaching(ORG, ana.person, { name: "cancel-order", goal: "Cancel an order" });
  ok((await boxOf(ana)).teach.join(",") === "start" && started.until > Date.now(), "the box is asked to start recording, with a ten-minute horizon");
  ok((await stateOf(ana)).teach?.name === "cancel-order" && (await stateOf(ana)).teach?.box === (await stateOf(ana)).box?.name, "the row records the recording, tied to the live box");
  await rejects(() => teach.startTeaching(ORG, ana.person, { name: "other", goal: "x" }), "already recording", "a second recording on the same box refuses");

  await lifecycle.takeOver(ORG, ana.person, "agent", deps, "show me how you cancel an order");
  const hb = getActionKind("browser.personal.handback")!;
  const args = { org: ORG, person: ana.person, principalId: "UANA", reason: "show me how you cancel an order", teach: "cancel-order" };
  ok(hb.summarize(args).some((l) => l.includes("never record the text you type into a field") && l.includes("can repeat it")) && hb.summarize(args).some((l) => l.includes("ends the recording")), "the hand-back card says it ends the recording, that field text is never recorded, and that a picked option can repeat it");
  await rejects(() => hb.execute(args, "UBOB"), "only the person", "🔴 another member's click on the hand-back card saves nothing");
  await rejects(() => hb.execute(args, "chain:rule-1"), "only the person", "🔴 a chain lowering is not the owner's click");
  ok((await stateOf(ana)).teach !== undefined && ((await stateOf(ana)).drafts ?? []).length === 0, "…and the recording is still running, with no draft");

  const said = await hb.execute(args, "UANA");
  ok(/saved your demonstration as the paused draft "cancel-order" \(7 steps\)/.test(String(said)), `the owner's click returns the controls and reports the draft (got: ${String(said)})`);
  const s = await stateOf(ana);
  ok(s.lock.holder === "agent" && s.teach === undefined, "the controls are back with the agent and the recording is over");
  ok((s.drafts ?? []).length === 1 && s.drafts![0]!.name === "cancel-order" && s.drafts![0]!.seconds === 95 && s.drafts![0]!.steps.length === 7, "ONE draft is saved with the re-checked steps");
  ok((await boxOf(ana)).teach.join(",") === "start,stop", "the box was asked to stop exactly once");
  ok(!JSON.stringify(s.drafts).includes("s3cr3t"), "🔴 the saved draft carries no query string");
  ok((await lifecycle.handBack(ORG, ana.person, "page", deps)) === false && (await stateOf(ana)).drafts!.length === 1, "a second hand-back changes nothing and saves no second draft");
  await rejects(() => teach.startTeaching(ORG, ana.person, { name: "cancel-order", goal: "again" }), "already have a draft", "a name already used by a draft refuses");
}

{
  const bob = ownerFor("UBOB");
  await lifecycle.ensureBrowserOpen(bob, ["shop.example"], deps);
  await teach.startTeaching(ORG, bob.person, { name: "by-page", goal: "x" });
  await lifecycle.takeOver(ORG, bob.person, "agent", deps);
  ok((await lifecycle.handBack(ORG, bob.person, "page", deps)) === true && (await stateOf(bob)).drafts?.[0]?.name === "by-page", "Hand back on the page saves the draft too");

  await teach.startTeaching(ORG, bob.person, { name: "by-expiry", goal: "x" });
  await lifecycle.takeOver(ORG, bob.person, "agent", deps);
  const later = Date.now() + (ON.takeoverMinutes + 1) * 60_000;
  await lifecycle.sweepPersonalBrowsers(ORG, { ...deps, now: () => later, halted: async () => false });
  ok((await stateOf(bob)).drafts?.some((d) => d.name === "by-expiry") === true, "an expired hold returned by the sweep saves the draft");

  await lifecycle.takeOver(ORG, bob.person, "agent", deps);
  ok((await lifecycle.handBack(ORG, bob.person, "page", deps)) === true && (await stateOf(bob)).drafts!.length === 2, "a hand-back with no recording saves no draft");

  await teach.startTeaching(ORG, bob.person, { name: "stale", goal: "x" });
  await storeMod.updatePersonalBrowser(ORG, bob.person, (cur) => ({ next: { ...cur!, teach: { ...cur!.teach!, box: "an-older-box" } }, result: undefined }));
  const lostRows = (await audit()).filter((r) => r.action === "browser.personal.teach" && r.detail?.["phase"] === "lost").length;
  ok((await teach.finishTeaching(ORG, bob.person)) === undefined && (await stateOf(bob)).teach === undefined && !(await stateOf(bob)).drafts!.some((d) => d.name === "stale"), "🔴 a recording on a box that has since closed is cleared, not saved");
  ok((await audit()).filter((r) => r.action === "browser.personal.teach" && r.detail?.["phase"] === "lost").length === lostRows + 1, "…and audited `lost`, as the registry says");

  await teach.startTeaching(ORG, bob.person, { name: "by-close", goal: "x" });
  await lifecycle.closeBrowser(ORG, bob.person, "closed", deps, "UBOB");
  ok((await stateOf(bob)).drafts!.some((d) => d.name === "by-close") && (await stateOf(bob)).box === undefined, "the person's own close saves the draft, then closes");

  await lifecycle.ensureBrowserOpen(bob, ["shop.example"], deps);
  (await boxOf(bob)).teachOk = false;
  await rejects(() => teach.startTeaching(ORG, bob.person, { name: "old-image", goal: "x" }), "could not start the recording", "a box that cannot record refuses the start");
  ok((await stateOf(bob)).teach === undefined, "…and leaves no recording on the row");
  (await boxOf(bob)).teachOk = true;

  await teach.startTeaching(ORG, bob.person, { name: "raced", goal: "x" });
  const lostBefore = (await audit()).filter((r) => r.action === "browser.personal.teach" && r.detail?.["phase"] === "lost").length;
  (await boxOf(bob)).stopDelayMs = 300;
  const [r1, r2] = await Promise.all([teach.finishTeaching(ORG, bob.person), teach.finishTeaching(ORG, bob.person)]);
  (await boxOf(bob)).stopDelayMs = 0;
  const raced = (await stateOf(bob)).drafts!.filter((d) => d.name === "raced");
  ok(raced.length === 1 && raced[0]!.steps.length === 7 && [r1, r2].filter((r) => r !== undefined).length === 1, "🔴 two racing finishers save ONE draft, with the real steps");
  ok((await audit()).filter((r) => r.action === "browser.personal.teach" && r.detail?.["phase"] === "lost").length === lostBefore, "🔴 …and the loser, whose stop said `none`, writes no `lost` row");
  await teach.discardDraft(ORG, bob.person, "raced");

  await teach.startTeaching(ORG, bob.person, { name: "failed-handoff", goal: "x" });
  const lostBeforeAbandon = (await audit()).filter((r) => r.action === "browser.personal.teach" && r.detail?.["phase"] === "lost").length;
  await teach.abandonTeaching(ORG, bob.person);
  ok((await stateOf(bob)).teach === undefined && !(await boxOf(bob)).recording, "a failed hand-off's recording is cleared, on the row and at the box");
  ok((await audit()).filter((r) => r.action === "browser.personal.teach" && r.detail?.["phase"] === "lost").length === lostBeforeAbandon + 1, "…and audited `lost` exactly once");
  ok(!(await stateOf(bob)).drafts!.some((d) => d.name === "failed-handoff"), "…and saves no draft");

  for (const n of ["d4", "d5"]) {
    await teach.startTeaching(ORG, bob.person, { name: n, goal: "x" });
    await teach.finishTeaching(ORG, bob.person);
  }
  ok((await stateOf(bob)).drafts!.length === teach.MAX_TAUGHT_DRAFTS, "a person keeps up to five drafts");
  await rejects(() => teach.startTeaching(ORG, bob.person, { name: "sixth", goal: "x" }), "propose or discard one first", "🔴 a sixth draft refuses — no draft is evicted");
  ok((await teach.discardDraft(ORG, bob.person, "d5")) === true && (await teach.discardDraft(ORG, bob.person, "d5")) === false && (await stateOf(bob)).drafts!.length === 4, "discard deletes one draft, once");
}

{
  const vercel = fakeBackend(true);
  const vdeps = { backend: vercel, policy: ON, healthWaitMs: 200 };
  const cara = ownerFor("UCARA");
  const first = await lifecycle.ensureBrowserOpen(cara, ["shop.example"], vdeps);
  await teach.startTeaching(ORG, cara.person, { name: "swept", goal: "x" });
  const lostBefore = (await audit()).filter((r) => r.action === "browser.personal.teach" && r.detail?.["phase"] === "lost").length;
  await lifecycle.closeBrowser(ORG, cara.person, "idle", vdeps);
  ok((await stateOf(cara)).teach === undefined, "🔴 a close for any reason drops the recording with its box");
  ok((await audit()).filter((r) => r.action === "browser.personal.teach" && r.detail?.["phase"] === "lost").length === lostBefore + 1, "…and audits it `lost` exactly once");
  await new Promise((r) => setTimeout(r, 5));
  const second = await lifecycle.ensureBrowserOpen(cara, ["shop.example"], vdeps);
  ok(second.state.box.name === first.state.box.name, "the reopened box carries the SAME name, as on Vercel");
  await teach.startTeaching(ORG, cara.person, { name: "after-sweep", goal: "x" });
  ok((await stateOf(cara)).teach?.name === "after-sweep", "🔴 a new recording starts after the sweep — nothing stale refuses it");

  await storeMod.updatePersonalBrowser(ORG, cara.person, (cur) => ({ next: { ...cur!, teach: { ...cur!.teach!, startedAt: cur!.box!.createdAt - 1 } }, result: undefined }));
  await teach.startTeaching(ORG, cara.person, { name: "over-stale", goal: "x" });
  ok((await stateOf(cara)).teach?.name === "over-stale", "a recording older than the live box does not refuse a new one");
  ok((await teach.finishTeaching(ORG, cara.person)) !== undefined, "…and the new one is saved at the hand-back");

  await storeMod.updatePersonalBrowser(ORG, cara.person, (cur) => ({ next: { ...cur!, teach: { name: "ghost", goal: "x", box: cur!.box!.name, startedAt: cur!.box!.createdAt - 1, until: Date.now() } }, result: undefined }));
  const lostGhost = (await audit()).filter((r) => r.action === "browser.personal.teach" && r.detail?.["phase"] === "lost").length;
  ok((await teach.finishTeaching(ORG, cara.person)) === undefined && (await stateOf(cara)).teach === undefined, "🔴 a hand-back clears a recording older than the live box, even under the same name");
  ok((await audit()).filter((r) => r.action === "browser.personal.teach" && r.detail?.["phase"] === "lost").length === lostGhost + 1, "…and audits it `lost`");
}

{
  const draft = teach.findDraft(await stateOf(ana), "cancel-order")!;
  const ops: string[] = [];
  const fakeRead: Parameters<typeof teach.rehearseDraft>[1] = async (op, args) => {
    ops.push(op);
    if (op === "find") return { kind: "done", page: { ok: true, found: args["name"] === "Your orders" ? "e1" : null } };
    return { kind: "done", page: { ok: true, url: String(args["url"]) } };
  };
  const report = await teach.rehearseDraft(draft, fakeRead);
  ok(ops.every((o) => o === "go" || o === "find"), "🔴 the rehearsal only reads — it never clicks, types, selects or presses a key");
  ok(report.found === 3 && report.missing === 2 && report.unchecked === 2, `the report counts found, missing and unchecked steps (got ${report.found}/${report.missing}/${report.unchecked})`);
  const text = teach.renderRehearsal(report);
  ok(text.includes("skipped (the person types it)") && text.includes("not pressed") && text.includes("NOT FOUND"), "the report names the secret field it skipped, the key it did not press, and what it did not find");

  const s = await stateOf(ana);
  const live = await lifecycle.ensureBrowserOpen(ana, ["shop.example"], deps);
  const box = await boxOf(ana);
  box.cmds.length = 0;
  const real = await teach.rehearseDraft(draft, (op, args) => lifecycle.actOnBrowser(live.state, op, args, deps));
  ok(box.cmds.length > 0 && box.cmds.every((c) => c["op"] === "go" || c["op"] === "find"), "🔴 on the real lifecycle the box receives only go and find");
  ok(real.found >= 2 && real.stopped === undefined, "the rehearsal finds the recorded elements the page holds");
  await teach.recordRehearsal(s, draft.name, real);
  ok(teach.findDraft(await stateOf(ana), "cancel-order")!.rehearsal?.found === real.found, "the rehearsal's counts are recorded on the draft");

  await lifecycle.takeOver(ORG, ana.person, "agent", deps);
  const held = await teach.rehearseDraft(draft, (op, args) => lifecycle.actOnBrowser(live.state, op, args, deps));
  ok(held.stopped !== undefined && /controls/.test(held.stopped) && held.lines.length === 0, "while the person holds the controls the rehearsal stops at once");
  await lifecycle.handBack(ORG, ana.person, "page", deps);
}

{
  const opened: { head: string; title: string; body: string }[] = [];
  const puts: { path: string; branch: string; content: string }[] = [];
  const provider = {
    async resolveWriteToken() {
      return "t";
    },
    committer: () => ({ name: "bot", email: "bot@example.invalid" }),
    async getBranchSha(a: { branch: string }) {
      return a.branch === "main" ? "base0" : puts.some((p) => p.branch === a.branch) ? "head1" : null;
    },
    async ensureBranch() {},
    async getFile() {
      return null;
    },
    async putFile(a: { path: string; branch: string; content: string }) {
      puts.push({ path: a.path, branch: a.branch, content: a.content });
    },
    async openOrReopenPr(a: { head: string; title: string; body: string }) {
      opened.push(a);
      return { url: "https://example.invalid/pull/9", number: 9, updated: opened.length > 1, reopened: false };
    },
    async listPrFeedback() {
      return [];
    },
  } as unknown as ConfigPrProvider;
  const s = await stateOf(ana);
  const draft = teach.findDraft(s, "cancel-order")!;
  const r = await teach.proposeDraft(s, draft, { provider, repo: "acme/config", base: "main", armed: true, priorPrs: [] });
  ok(r.opened && r.number === 9 && opened.length === 1, "ONE pull request opens");
  ok(puts[0]!.path === ".agents/skills/cancel-order/SKILL.md" && puts[0]!.content === teach.renderTaughtSkill(draft), "it commits the rendered SKILL.md under the skill's own path");
  ok(opened[0]!.title === "Skill proposal: cancel-order" && opened[0]!.body.includes("A person taught this task by demonstration") && opened[0]!.body.includes("4 gap(s)"), "the body says a person taught it and how many gaps to fill");
  ok(!opened[0]!.body.includes("dream cycle saw"), "…and does not claim the dream cycle saw it recur");
  ok(opened[0]!.body.includes("Merging is what arms it"), "the body keeps the merge-arms-it rule");
  const prRow = (await audit()).find((x) => x.action === SKILL_PROPOSAL_PR_ACTION);
  ok(prRow?.principalId === "UANA" && prRow.detail?.["origin"] === "taught" && prRow.detail?.["steps"] === 7, "🔴 the proposal's audit row names the person who asked, not the dream actor");
  ok(teach.findDraft(await stateOf(ana), "cancel-order")!.proposal?.number === 9, "the draft records its pull request and stays paused");

  const again = await teach.proposeDraft(await stateOf(ana), draft, { provider, repo: "acme/config", base: "main", armed: true, priorPrs: [] });
  ok(again.opened && opened.length === 2 && opened[1]!.head === opened[0]!.head && puts.length === 2 && puts[1]!.branch === puts[0]!.branch, "a second proposal of the same draft updates the same branch");
  const off = await teach.proposeDraft(await stateOf(ana), draft, { provider, repo: "acme/config", base: "main", armed: false, priorPrs: [] });
  ok(!off.opened && /skillProposalPr is off/.test(off.skipped ?? "") && opened.length === 2, "the deployment's skill-proposal switch still governs a taught proposal");

  const card = getActionKind("browser.personal.propose")!;
  ok(card !== undefined && card.policy === "member", "the propose card is a registered member-tier kind");
  const pArgs = { org: ORG, person: ana.person, principalId: "UANA", name: "cancel-order", steps: 7, gaps: 4 };
  const lines = card.summarize(pArgs).join(" ");
  ok(lines.includes("labels") && lines.includes("token") && lines.includes("Merging"), "🔴 the card says the pull request shows labels and paths, that a path can carry a token, and that merging arms it");
  await rejects(() => card.execute(pArgs, "UBOB"), "only the person", "🔴 another member's click opens no pull request");
  await rejects(() => card.execute(pArgs, "chain:judge"), "only the person", "🔴 an approver-chain lowering opens no pull request");
  const ran = String(await card.execute(pArgs, "UANA"));
  ok(/no pull request was opened|opened a pull request|dry run/.test(ran), `the owner's click reaches the proposal path (got: ${ran})`);
  ok(/is gone/.test(String(await card.execute({ ...pArgs, name: "no-such-draft" }, "UANA"))), "a card for a draft that is gone proposes nothing");
}

{
  const rows = (await audit()).filter((r) => r.action === "browser.personal.teach");
  const phases = new Set(rows.map((r) => String(r.detail?.["phase"])));
  for (const p of ["started", "recorded", "rehearsed", "discarded", "lost"]) ok(phases.has(p), `a browser.personal.teach row records the "${p}" phase`);
  const json = JSON.stringify(rows);
  ok(!json.includes("Your orders") && !json.includes("shop.example") && !json.includes("Search orders") && !json.includes("Cancel an order"), "🔴 no teach row carries a label, an address or the goal");
  const recorded = rows.find((r) => r.detail?.["phase"] === "recorded")!;
  ok(recorded.detail?.["steps"] === 7 && recorded.detail?.["typedFields"] === 2 && recorded.principalId !== undefined, "the recorded row counts the steps and the typed fields");
}

const _shape: TaughtStep = { kind: "back" };
void _shape;
console.log(`personal-browser-teach: ${passed} assertions passed`);
process.exit(0);
