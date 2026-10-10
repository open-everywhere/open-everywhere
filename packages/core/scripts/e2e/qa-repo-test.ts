import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditWireEntry } from "./audit-read.js";
import {
  freshQaRunToken,
  isQaShotRef,
  namesQaHeading,
  qaAuditGates,
  qaBrief,
  qaCheckoutEvidence,
  qaFixtureDrift,
  qaHeading,
  qaPageUrl,
  QA_FIXTURE_DIR,
  QA_FIXTURE_FILES,
  QA_HEADING_WORDS,
  QA_RUN_TOKEN_RE,
  QA_SHOT_FILE,
  writeQaFixture,
} from "./qa-repo.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

{
  const dir = mkdtempSync(join(tmpdir(), "oe-qa-repo-test-"));
  const written = writeQaFixture(dir);
  ok(written.length === Object.keys(QA_FIXTURE_FILES).length, "§1 --write writes every fixture file");
  const appDir = join(dir, QA_FIXTURE_DIR);
  for (const [path, text] of Object.entries(QA_FIXTURE_FILES)) {
    ok(readFileSync(join(dir, path), "utf8") === text, `§1 ${path} is written byte for byte`);
  }

  const pkg = JSON.parse(QA_FIXTURE_FILES[`${QA_FIXTURE_DIR}/package.json`]!) as Record<string, unknown>;
  ok(pkg.dependencies === undefined && pkg.devDependencies === undefined, "§1 the app has ZERO dependencies — the sandbox firewall blocks npm install");
  ok((pkg.scripts as Record<string, string>).dev === "node server.js", "§1 `npm run dev` is `node server.js`");
  ok(!/require\((?!"node:)/.test(QA_FIXTURE_FILES[`${QA_FIXTURE_DIR}/server.js`]!), "§1 server.js requires only node: built-ins");

  const child = spawn(process.execPath, ["server.js"], { cwd: appDir, env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`server.js did not report a port within 10 s: ${out}`)), 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        const m = /listening on http:\/\/localhost:(\d+)/.exec(out);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      child.on("exit", (code) => reject(new Error(`server.js exited with ${code}: ${out}`)));
    });
    const page = async (query: string): Promise<{ status: number; body: string }> => {
      const res = await fetch(`http://127.0.0.1:${port}/${query}`);
      return { status: res.status, body: await res.text() };
    };

    for (const run of ["qa-0000000000", "qa-abcdef0123", freshQaRunToken(), freshQaRunToken()]) {
      const { status, body } = await page(`?run=${run}`);
      const h1 = /<h1>([^<]*)<\/h1>/.exec(body)?.[1];
      ok(status === 200 && h1 === qaHeading(run), `§1 the served <h1> for run ${run} is qaHeading(run) (served "${h1}", predicted "${qaHeading(run)}")`);
    }
    const bare = await page("");
    ok(bare.status === 200 && !bare.body.includes("<h1>"), "§1 NEGATIVE CONTROL: with no run token the page renders no <h1>");
    const hostile = await page("?run=%3Cscript%3E");
    ok(!hostile.body.includes("<h1>") && !hostile.body.includes("<script>"), "§1 NEGATIVE CONTROL: a run token outside the allowed shape renders no <h1> and echoes nothing");
    ok((await page("other")).status === 404, "§1 a path other than / is 404");
  } finally {
    child.kill();
  }
}

{
  const run = "qa-0123456789";
  ok(qaHeading(run) === qaHeading(run), "§1b the heading is deterministic for one token");
  const [a, b] = qaHeading(run).split(" ");
  ok(QA_HEADING_WORDS.includes(a!) && QA_HEADING_WORDS.includes(b!), "§1b both words come from the vocabulary");
  ok(new Set(QA_HEADING_WORDS).size === 32, "§1b the vocabulary is 32 distinct words");
  const seen = new Set(Array.from({ length: 64 }, (_, i) => qaHeading(`qa-run-${i}`)));
  ok(seen.size > 32, `§1b different tokens give different headings (${seen.size} distinct of 64)`);
  const t = freshQaRunToken();
  ok(QA_RUN_TOKEN_RE.test(t) && t !== freshQaRunToken(), "§1b a fresh run token has the shape the server accepts and is new each time");
  ok(qaPageUrl(t) === `http://localhost:8000/?run=${t}`, "§1b the page URL carries the token on the declared localhost host");
}

{
  const current: Record<string, string | undefined> = { ...QA_FIXTURE_FILES };
  ok(qaFixtureDrift(current).length === 0, "§2 a fixture repo carrying every generated file reports no drift");
  const serverPath = `${QA_FIXTURE_DIR}/server.js`;
  const missing = qaFixtureDrift({ ...current, [serverPath]: undefined });
  ok(missing.length === 1 && missing[0]!.includes(`${serverPath} is absent`), "§2 an absent file is named as absent");
  const stale = qaFixtureDrift({ ...current, [serverPath]: current[serverPath]!.replace("oe-qa-fixture-v1", "oe-qa-fixture-v0") });
  ok(stale.length === 1 && stale[0]!.includes(`${serverPath} differs`), "§2 a one-byte-different copy (an old seed) is named as drift, never read as current");
  ok(qaFixtureDrift({}).length === Object.keys(QA_FIXTURE_FILES).length, "§2 an empty repo names every file");
}

{
  const row = (action: string, detail?: Record<string, unknown>): AuditWireEntry => ({
    ts: "2026-10-09T12:00:00.000Z",
    org: "o",
    platform: "slack",
    workspace: "w",
    action,
    ...(detail !== undefined ? { detail } : {}),
  });
  const brokered = row("egress.policy", { phase: "scm.broker", reason: "checkout_repo", enforced: true });
  const sessionPolicy = row("egress.policy", { phase: "session.started", reason: "first-apply", enforced: true });
  const navigate = row("browser.navigate");
  const screenshot = row("browser.screenshot");
  const vision = row("describe_image", { ok: true, ref: `workspace:${QA_SHOT_FILE}`, mimeType: "image/png" });
  const posted = row("slack.post_file", { count: 1, filenames: [QA_SHOT_FILE], attached: 1 });
  const full = [sessionPolicy, brokered, navigate, screenshot, vision, posted];

  const verdict = (rows: readonly AuditWireEntry[]): boolean[] => qaAuditGates(rows).map((g) => g.pass);
  ok(verdict(full).every(Boolean), "§3 the full chain passes every audit gate");
  ok(qaAuditGates(full).length === 5, "§3 there are five audit gates: checkout, navigate, screenshot, vision, post");

  const links: readonly [string, AuditWireEntry, number][] = [
    ["checkout (the scm.broker egress row)", brokered, 0],
    ["browser.navigate", navigate, 1],
    ["browser.screenshot", screenshot, 2],
    ["describe_image ok:true on the shot", vision, 3],
    ["slack.post_file", posted, 4],
  ];
  for (const [name, gone, index] of links) {
    const v = verdict(full.filter((r) => r !== gone));
    ok(v[index] === false && v.filter((p) => !p).length === 1, `§3 RED: without ${name}, gate ${index} fails and only that gate fails`);
  }

  const swap = (replacement: AuditWireEntry): boolean => verdict(full.map((r) => (r === vision ? replacement : r)))[3]!;
  ok(!swap(row("describe_image", { ok: false, reason: "fetch-failed", ref: `workspace:${QA_SHOT_FILE}` })), "§3 RED: a FAILED vision read of the shot does not pass the vision gate");
  ok(!swap(row("describe_image", { ok: true, ref: "workspace:other.png" })), "§3 RED: a vision read of some other image does not pass the vision gate");
  ok(!swap(row("describe_image", { ok: true, ref: "attachment:F123" })), "§3 RED: a vision read of a chat attachment does not pass the vision gate");
  ok(swap(row("describe_image", { ok: true, ref: `workspace:./work/${QA_SHOT_FILE}` })), "§3 a vision read of the shot under a subdirectory path still passes");
  ok(isQaShotRef(`workspace:${QA_SHOT_FILE}`) && !isQaShotRef(`workspace:not-${QA_SHOT_FILE}`) && !isQaShotRef(undefined), "§3 the shot ref matches the file name, not a suffix of another name");

  const postSwap = (replacement: AuditWireEntry): boolean => verdict(full.map((r) => (r === posted ? replacement : r)))[4]!;
  ok(!postSwap(row("slack.post_file", { count: 1, filenames: ["page.html"] })), "§3 RED: posting only an HTML file does not pass the post gate");
  ok(!postSwap(row("slack.post_file", { count: 1, filenames: ["other.png"] })), "§3 RED: a PNG that is not this leg's shot does not pass the post gate");
  ok(!postSwap(row("discord.post_file", { count: 1, filenames: [QA_SHOT_FILE] })), "§3 RED: a post on another surface does not pass the Slack post gate");

  ok(qaCheckoutEvidence(full).kind === "brokered", "§3 an enforced checkout reads as brokered");
  const unenforced = [row("egress.policy", { phase: "session.started", enforced: false }), navigate, screenshot, vision, posted];
  ok(qaCheckoutEvidence(unenforced).kind === "unenforced" && verdict(unenforced)[0] === true, "§3 an unenforced firewall writes no checkout row, and the gate passes");
  ok(qaAuditGates(unenforced)[0]!.label.includes("no row proves which tool fetched the repo"), "§3 …while its label says no row proves the checkout");
  ok(!qaAuditGates(full)[0]!.label.includes("no row proves"), "§3 NEGATIVE CONTROL: the brokered label does not carry the unenforced disclaimer");
  ok(
    qaCheckoutEvidence([row("egress.policy", { phase: "session.started", enforced: false, aborted: true })]).kind === "none",
    "§3 RED: an ABORTED session start (enforced:false on an enforced deployment) is not unenforced-checkout evidence",
  );
  ok(
    qaCheckoutEvidence([row("egress.policy", { phase: "turn.started", enforced: false })]).kind === "none",
    "§3 RED: only a session-start row says the deployment runs unenforced",
  );
  ok(qaCheckoutEvidence([sessionPolicy]).kind === "none", "§3 RED: an enforced session with no broker row has no checkout evidence");
  ok(
    qaCheckoutEvidence([row("egress.policy", { phase: "scm.broker", reason: "open_pull_request.push" })]).kind === "none",
    "§3 RED: a broker row from open_pull_request is not checkout evidence",
  );
}

{
  const heading = "HERON MAPLE";
  ok(namesQaHeading("The heading reads: HERON MAPLE", heading), "§4 the exact heading passes");
  ok(namesQaHeading("heading is *Heron Maple*.", heading), "§4 case and markdown emphasis do not matter");
  ok(namesQaHeading("HERON-MAPLE", heading), "§4 a hyphen between the words passes");
  ok(!namesQaHeading("MAPLE HERON", heading), "§4 RED: the words in the wrong order fail");
  ok(!namesQaHeading("I saw HERON on the page", heading), "§4 RED: one word alone fails");
  ok(!namesQaHeading("HERONS MAPLE", heading), "§4 RED: a different word that contains the first word fails");
  ok(!namesQaHeading("Scratch QA — no run token", heading), "§4 RED: the no-token page's text fails");
}

{
  let leaks = 0;
  for (let i = 0; i < 200; i++) {
    const run = `qa-brief-${i}`;
    const brief = qaBrief("example-owner/e2e-scratch", run);
    if (namesQaHeading(brief, qaHeading(run))) leaks++;
  }
  ok(leaks === 0, "§5 across 200 tokens the brief never names its own heading — a brief that did would let a reply pass without a screenshot");
  const brief = qaBrief("example-owner/e2e-scratch", "qa-x1");
  for (const needle of ["checkout_repo", "npm run dev", "browser_navigate", "browser_screenshot", "describe_image", "post_file", qaPageUrl("qa-x1"), QA_SHOT_FILE, "npm install"]) {
    ok(brief.includes(needle), `§5 the brief names ${needle}`);
  }
}

{
  const src = readFileSync(new URL("./scenarios.ts", import.meta.url), "utf8");
  const start = src.indexOf('id: "F-QA-REPO"');
  ok(start > 0, "§6 F-QA-REPO is in the scenario table under that id");
  const body = src.slice(start, src.indexOf("\n  {\n    id: ", start));
  ok(body.length > 2000, "§6 the leg body was sliced to the next scenario, not to nothing");
  ok(/requires: \["slack", "pr"\]/.test(body), '§6 the leg requires "slack" (the thread) and "pr" (the granted fixture repo and the driver PAT)');
  const at = (needle: string): number => body.indexOf(needle);
  ok(at("qaFixtureDrift(remote)") > 0 && at("ctx.fixtureMissing(") > at("qaFixtureDrift(remote)"), "§6 a drifted fixture ends the leg as FIXTURE-MISSING");
  ok(at("ctx.fixtureMissing(") < at("slack.post("), "§6 the fixture is read BEFORE the leg drives anything");
  ok(body.includes("qa-repo.ts --write"), "§6 the fixture-missing message names the provisioning command");
  ok(at("auditStoreMark(") > 0 && at("auditStoreMark(") < at("slack.post("), "§6 the store mark is taken before the post, so only this leg's rows count");
  ok(at("qaBrief(repo, run)") > 0, "§6 the leg posts qaBrief — the brief §5 proves never names the heading");
  ok(at("delegationHasReturned(rows)") > at("slack.post(") && at("delegationHasReturned(rows)") < at("qaAuditGates(rows)"), "§6 the audit rows are read only after the delegated task settles (OPE-1076)");
  ok(/for \(const g of qaAuditGates\(rows\)\) ctx\.gate\(g\.pass, g\.label\)/.test(body), "§6 every audit gate of qaAuditGates is a hard ctx.gate");
  ok(/ctx\.gate\(\s*named !== undefined/.test(body) && at("namesQaHeading(text, heading)") > 0, "§6 the heading gate is a hard ctx.gate on namesQaHeading — never a judge, which does not enforce mustMatch");
  ok(at('filetype: "png"') > 0, "§6 the leg waits for a Slack reply carrying the PNG");
}

console.log(`✓ ${n} F-QA-REPO fixture and gate assertions passed`);
