import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { parseEnv } from "node:util";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as mint from "../agent/scm/mint.js";
import { SCM_MINT_JOB_SETS, scmAppPermissionFloor, unionPermissions } from "../agent/scm/app-permissions.js";
import {
  registerSurfaceAppCreateFlow,
  startSurfaceAppCreate,
  surfaceAppCreateStatus,
  _stopSurfaceAppCreateForTest,
  type SurfaceAppCreateFlow,
} from "../agent/ops/surface-app-create.js";
import { buildOpsServer, OPS_TOOL_NAMES } from "../agent/ops/server.js";

let n = 0;
const ok = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  n++;
};

{
  const jobSets = Object.entries(mint).filter(
    ([name, value]) =>
      name.endsWith("_PERMISSIONS") &&
      typeof value === "object" &&
      value !== null &&
      Object.values(value).every((g) => g === "read" || g === "write"),
  );
  ok(`scm/mint.ts exports job sets (${jobSets.length})`, jobSets.length >= 7);
  const listed = new Set(Object.values(SCM_MINT_JOB_SETS));
  const unlisted = jobSets.filter(([, value]) => !listed.has(value as never)).map(([name]) => name);
  ok(`🔴 every mint job set is in SCM_MINT_JOB_SETS, so the App holds it (unlisted: ${unlisted.join(", ") || "none"})`, unlisted.length === 0);

  const floor = scmAppPermissionFloor() as Record<string, string>;
  for (const [name, value] of jobSets) {
    for (const [family, grade] of Object.entries(value as Record<string, string>)) {
      ok(`the floor covers ${name}.${family}=${grade}`, floor[family] === "write" || floor[family] === grade);
    }
  }
  ok("the floor is the union, at the stronger grade", JSON.stringify(floor) === JSON.stringify({ contents: "write", issues: "write", metadata: "read", pull_requests: "write" }));
  ok("no capability-only family reaches the floor", floor.workflows === undefined);
  ok("unionPermissions keeps write over read, in either order", unionPermissions([{ a: "read" }, { a: "write" }]).a === "write" && unionPermissions([{ a: "write" }, { a: "read" }]).a === "write");
  ok("unionPermissions sorts by family", Object.keys(unionPermissions([{ b: "read", a: "read" }])).join() === "a,b");
}

{
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const SECRET = "fixture-webhook-secret-value-7f3a";
  let exchanges = 0;
  let failNext = false;
  let delayMs = 0;
  const flow: SurfaceAppCreateFlow = {
    vendor: "Fakehub",
    variants: [
      { name: "full", summary: "everything" },
      { name: "small", summary: "less" },
    ],
    appNameMax: 20,
    ownerProblem: (o) => (/^[a-z]+$/.test(o) ? undefined : "not a login"),
    createUrl: ({ owner, state }) => `https://fakehub.test/${owner ?? "me"}/apps/new?state=${state}`,
    manifestField: "manifest",
    manifest: ({ host, variant, redirectUrl, appName }) => ({ name: appName ?? "Default", hook: `https://${host}/hook`, variant, redirect_url: redirectUrl }),
    envNames: (variant) => (variant === "full" ? ["FAKE_APP_ID", "FAKE_PRIVATE_KEY", "FAKE_WEBHOOK_SECRET"] : ["FAKE_APP_ID"]),
    codeProblem: (code) => (/^[a-z0-9]+$/.test(code) ? undefined : "bad code"),
    exchange: async ({ code }) => {
      exchanges++;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (failNext) throw new Error("Fakehub refused the code (HTTP 404)");
      return { env: { FAKE_APP_ID: `42${code}`, FAKE_PRIVATE_KEY: privateKey, FAKE_WEBHOOK_SECRET: SECRET }, appName: "Acme Agent", installUrl: "https://fakehub.test/apps/acme/install" };
    },
    after: ["install it"],
  };
  registerSurfaceAppCreateFlow("fakehub", flow);

  const dir = mkdtempSync(join(tmpdir(), "oe-app-create-"));
  const file = join(dir, ".env.local");
  writeFileSync(file, "# existing\nOTHER=1\n", "utf-8");
  const outerProject = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = dir;

  ok("surface_app_create is a declared ops tool", (OPS_TOOL_NAMES as readonly string[]).includes("surface_app_create"));
  const server = buildOpsServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "ops-app-create-test", version: "0" });
  await client.connect(ct);
  const replies: string[] = [];
  const call = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: "surface_app_create", arguments: args });
    const text = (r.content as { type: string; text: string }[])[0]!.text;
    replies.push(text);
    return JSON.parse(text) as Record<string, unknown>;
  };

  const unknown = await call({ surface: "nope", baseUrl: "oe.example.com" });
  ok("an unregistered surface is refused, naming the registered ones", unknown.ok === false && (unknown.available as string[]).includes("fakehub"));
  ok("start without baseUrl is refused", (await call({ surface: "fakehub" })).ok === false);
  const badHost = await call({ surface: "fakehub", baseUrl: "https://hooks.example.com/services/T0/B0/xyzzy-secret-path" });
  ok("a baseUrl that is not a host is refused without echoing it", badHost.ok === false && !JSON.stringify(badHost).includes("xyzzy"));
  ok("an unknown variant is refused", (await call({ surface: "fakehub", baseUrl: "oe.example.com", variant: "huge" })).ok === false);
  ok("an over-long app name is refused", (await call({ surface: "fakehub", baseUrl: "oe.example.com", appName: "x".repeat(21) })).ok === false);
  ok("a bad owner is refused", (await call({ surface: "fakehub", baseUrl: "oe.example.com", owner: "Not A Login" })).ok === false);
  ok("a tracked env target is refused", (await call({ surface: "fakehub", baseUrl: "oe.example.com", path: ".env.example" })).ok === false);
  ok("status before any start says so", (await call({ surface: "fakehub", action: "status" })).ok === false);

  const started = await call({ surface: "fakehub", baseUrl: "https://oe.example.com/", appName: "Acme Agent", owner: "acme" });
  const openUrl = String(started.openUrl);
  ok("start answers ok, waiting", started.ok === true && started.state === "waiting");
  ok("the page binds 127.0.0.1 only", openUrl.startsWith("http://127.0.0.1:"));
  ok("start lists the names it will write", JSON.stringify(started.writes) === JSON.stringify(["FAKE_APP_ID", "FAKE_PRIVATE_KEY", "FAKE_WEBHOOK_SECRET"]));
  const state = new URL(openUrl).searchParams.get("state")!;
  const origin = new URL(openUrl).origin;

  const wrongStart = await fetch(`${origin}/start?state=${"0".repeat(64)}`);
  ok("the start page refuses a wrong state", wrongStart.status === 404);
  const startPage = await fetch(openUrl);
  const html = await startPage.text();
  ok("the start page serves the form", startPage.status === 200 && html.includes(`action="https://fakehub.test/acme/apps/new?state=${state}"`));
  ok("the form carries the manifest for this host, HTML-escaped", html.includes("&quot;hook&quot;:&quot;https://oe.example.com/hook&quot;") && html.includes("&quot;name&quot;:&quot;Acme Agent&quot;"));
  ok("the manifest's redirect is this page's callback", html.includes(`&quot;redirect_url&quot;:&quot;${origin}/callback&quot;`));

  const forged = await fetch(`${origin}/callback?code=attacker&state=${"0".repeat(64)}`);
  ok("🔴 a callback with a wrong state is refused", forged.status === 400);
  const noState = await fetch(`${origin}/callback?code=attacker`);
  ok("🔴 a callback with no state is refused", noState.status === 400);
  ok("…and the vendor was never called", exchanges === 0);
  ok("…and nothing was written", !readFileSync(file, "utf-8").includes("FAKE_"));
  ok("…and the flow still waits", surfaceAppCreateStatus("fakehub")?.state === "waiting");
  const badCode = await fetch(`${origin}/callback?code=${encodeURIComponent("../x")}&state=${state}`);
  ok("a code the vendor never issues fails the flow without a call", badCode.status === 400 && exchanges === 0 && surfaceAppCreateStatus("fakehub")?.state === "failed");

  const again = await call({ surface: "fakehub", baseUrl: "oe.example.com", appName: "Acme Agent" });
  const state2 = new URL(String(again.openUrl)).searchParams.get("state")!;
  const origin2 = new URL(String(again.openUrl)).origin;
  ok("a new start mints a new state", state2 !== state);
  const done = await fetch(`${origin2}/callback?code=abc123&state=${state2}`);
  const donePage = await done.text();
  ok("the right state and code finish the flow", done.status === 200 && exchanges === 1);
  ok("the done page names the app and links its install", donePage.includes("Acme Agent is ready") && donePage.includes('href="https://fakehub.test/apps/acme/install"'));
  ok("🔴 the done page carries no value", !donePage.includes(SECRET) && !donePage.includes("PRIVATE KEY"));
  const env = parseEnv(readFileSync(file, "utf-8"));
  ok("the keys land in the env file", env.FAKE_APP_ID === "42abc123" && env.FAKE_WEBHOOK_SECRET === SECRET);
  ok("the file keeps its other lines", env.OTHER === "1" && readFileSync(file, "utf-8").includes("# existing"));
  ok("the PEM is one line, with its breaks escaped", !/\n[A-Za-z0-9+/=]{20,}\n/.test(readFileSync(file, "utf-8")) && (env.FAKE_PRIVATE_KEY ?? "").includes("\\n"));
  ok("the PEM parses as the runtime reads it", mint.parsePrivateKey(env.FAKE_PRIVATE_KEY ?? "").asymmetricKeyType === "rsa");

  const status = await call({ surface: "fakehub", action: "status" });
  ok("status reports done, with the names written", status.state === "done" && JSON.stringify(status.written) === JSON.stringify(["FAKE_APP_ID", "FAKE_PRIVATE_KEY", "FAKE_WEBHOOK_SECRET"]));
  ok("status names the app and its install link, and the steps after", status.appName === "Acme Agent" && status.installUrl === "https://fakehub.test/apps/acme/install" && Array.isArray(status.after));
  await new Promise((r) => setTimeout(r, 20));
  const replay = await fetch(`${origin2}/callback?code=abc123&state=${state2}`).then((r) => r.status, () => "closed");
  ok("a replayed callback reaches nothing", replay === "closed" || replay === 404);
  ok("…and the vendor was not called again", exchanges === 1);

  const held = await call({ surface: "fakehub", baseUrl: "oe.example.com" });
  ok("🔴 a start over names the file holds is refused", held.ok === false && JSON.stringify(held.alreadySet) === JSON.stringify(["FAKE_APP_ID", "FAKE_PRIVATE_KEY", "FAKE_WEBHOOK_SECRET"]));
  ok("a smaller variant checks only its own names", (await call({ surface: "fakehub", baseUrl: "oe.example.com", variant: "small" })).ok === false);
  const replaced = await call({ surface: "fakehub", baseUrl: "oe.example.com", replace: true });
  ok("replace:true starts anyway", replaced.ok === true);

  failNext = true;
  const before = readFileSync(file, "utf-8");
  const s3 = new URL(String(replaced.openUrl));
  const refused = await fetch(`${s3.origin}/callback?code=zzz&state=${s3.searchParams.get("state")}`);
  const refusedPage = await refused.text();
  ok("a vendor refusal shows on the page", refused.status === 502 && refusedPage.includes("HTTP 404"));
  ok("…fails the flow with the reason", surfaceAppCreateStatus("fakehub")?.state === "failed" && surfaceAppCreateStatus("fakehub")?.problem?.includes("HTTP 404") === true);
  ok("…and leaves the file alone", readFileSync(file, "utf-8") === before);

  failNext = false;
  delayMs = 50;
  const race = await call({ surface: "fakehub", baseUrl: "oe.example.com", replace: true });
  const r4 = new URL(String(race.openUrl));
  const raceUrl = `${r4.origin}/callback?code=race1&state=${r4.searchParams.get("state")}`;
  const before4 = exchanges;
  const raced = await Promise.all([fetch(raceUrl), fetch(raceUrl)].map((p) => p.then(async (r) => ({ status: r.status, body: await r.text() }))));
  const codes = raced.map((r) => r.status).sort();
  ok("the refused reload says the setup is in progress, not finished", raced.some((r) => r.status === 409 && r.body.includes("Setup in progress")));
  ok(`🔴 two concurrent callbacks: one finishes, one is refused (${codes.join(",")})`, JSON.stringify(codes) === "[200,409]");
  ok("🔴 …and the vendor was called once", exchanges === before4 + 1);
  ok("🔴 …and the status says done, matching the file", surfaceAppCreateStatus("fakehub")?.state === "done" && parseEnv(readFileSync(file, "utf-8")).FAKE_APP_ID === "42race1");

  const old = await call({ surface: "fakehub", baseUrl: "oe.example.com", replace: true });
  const r5 = new URL(String(old.openUrl));
  const pending = fetch(`${r5.origin}/callback?code=stale1&state=${r5.searchParams.get("state")}`).then(
    async (r) => ({ status: r.status, body: await r.text() }),
    () => ({ status: "closed" as const, body: "" }),
  );
  await new Promise((r) => setTimeout(r, 10));
  await call({ surface: "fakehub", baseUrl: "oe.example.com", replace: true });
  const stale = await pending;
  ok(`🔴 the replaced flow's late exchange is refused (${stale.status})`, stale.status === 409 || stale.status === "closed");
  ok("…and when its page answers, it says the app exists and must be deleted", stale.status === "closed" || (stale.body.includes("Acme Agent exists on Fakehub") && stale.body.includes("a newer setup started")));
  ok("🔴 …and its keys never land", parseEnv(readFileSync(file, "utf-8")).FAKE_APP_ID === "42race1");
  ok("…and the new flow still waits", surfaceAppCreateStatus("fakehub")?.state === "waiting");
  delayMs = 0;

  const dirTarget = ".env.broken.local";
  const broken = await call({ surface: "fakehub", baseUrl: "oe.example.com", path: dirTarget });
  ok("start accepts a new env file", broken.ok === true);
  mkdirSync(join(dir, dirTarget));
  const r6 = new URL(String(broken.openUrl));
  const thrown = await fetch(`${r6.origin}/callback?code=dir1&state=${r6.searchParams.get("state")}`);
  const thrownPage = await thrown.text();
  ok("🔴 a throwing write fails the flow", thrown.status === 500 && surfaceAppCreateStatus("fakehub")?.state === "failed");
  ok("…naming the app that now exists", surfaceAppCreateStatus("fakehub")?.appName === "Acme Agent" && thrownPage.includes("Acme Agent exists on Fakehub"));

  delayMs = 120;
  let expiredWrites = 0;
  const exp = await startSurfaceAppCreate({
    surface: "fakehub",
    flow,
    host: "oe.example.com",
    variant: "full",
    ttlMs: 40,
    writeEnv: () => {
      expiredWrites++;
      return undefined;
    },
  });
  const r7 = new URL(exp.openUrl);
  const expiredRes = await fetch(`${r7.origin}/callback?code=exp1&state=${r7.searchParams.get("state")}`).then(
    async (r) => ({ status: r.status, body: await r.text() }),
    () => ({ status: "closed" as const, body: "" }),
  );
  ok(`the expired flow's page answers (${expiredRes.status})`, expiredRes.status === 409);
  ok("…saying it expired and to start again, never 'newer setup'", expiredRes.body.includes("this setup expired") && expiredRes.body.includes("start again") && !expiredRes.body.includes("newer setup"));
  ok("🔴 …writing no keys", expiredWrites === 0);
  ok("🔴 …and the status names the app that now exists", surfaceAppCreateStatus("fakehub")?.state === "expired" && surfaceAppCreateStatus("fakehub")?.appName === "Acme Agent");
  delayMs = 0;

  const all = replies.join("\n");
  ok("🔴 no tool reply carries the webhook secret", !all.includes(SECRET));
  ok("🔴 no tool reply carries the private key", !all.includes("PRIVATE KEY"));

  await _stopSurfaceAppCreateForTest();
  await client.close();
  if (outerProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = outerProject;
}

console.log(`✓ ops-app-create: ${n} assertions passed`);
// proves: OPS-surface_app_create
