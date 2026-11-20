// The eve 1.0 agent-info split: `GET /eve/v1/info` serves only operator principals unless an
// eve-channel authenticator grants `allowAgentInfo`. OE authors no eve channel, so eve's default
// channel serves the route. These checks hold the split on the installed eve, hold OE's own
// authenticators to it, and prove that OE grants neither info access nor tool stubs anywhere.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { eveChannel, type EveAuthFn } from "eve/channels/eve";
import { injectTokenAuth, serviceTokenAuth, type ServiceTokenEntry } from "../agent/control/auth.js";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const INFO_PATH = "/eve/v1/info";
type Route = { readonly method: string; readonly path: string; readonly handler: (req: Request, args: unknown) => Promise<Response> };

function infoRoute(auth: EveAuthFn | readonly EveAuthFn[]): Route {
  const routes = (eveChannel({ auth }) as unknown as { readonly routes: readonly Route[] }).routes;
  const route = routes.find((r) => r.method === "GET" && r.path === INFO_PATH);
  ok(route !== undefined, `eve's eve channel still mounts GET ${INFO_PATH} — a moved route makes every check below vacuous`);
  return route!;
}

async function infoStatus(auth: EveAuthFn | readonly EveAuthFn[], headers: Record<string, string> = {}): Promise<{ status: number; code?: string }> {
  const res = await infoRoute(auth).handler(new Request(`https://agent.example${INFO_PATH}`, { headers }), {});
  const body = (await res.json().catch(() => ({}))) as { code?: string };
  return { status: res.status, ...(body.code === undefined ? {} : { code: body.code }) };
}

const endUser: EveAuthFn = () => ({
  authenticator: "test-user",
  issuer: "https://idp.example",
  principalId: "user-1",
  principalType: "user",
  subject: "user-1",
  attributes: {},
});

// 1. The split itself, on the installed eve.
{
  const denied = await infoStatus(endUser);
  ok(denied.status === 403, `an end-user principal gets 403 from ${INFO_PATH} (got ${denied.status})`);
  ok(denied.code === "info_forbidden", `…with eve's \`info_forbidden\` code (got ${denied.code})`);

  // Negative control: the same principal with an explicit grant passes the info check. With no
  // dispatch context, eve then answers 500 ("requires internal channel dispatch context"), so a
  // 500 here proves the check passed and the 403 above comes from the principal.
  const granted = await infoStatus(() => ({ ...(endUser(new Request("https://x")) as object), allowAgentInfo: true }) as never);
  ok(granted.status === 500, `control: the same principal with allowAgentInfo: true passes eve's info access check (got ${granted.status}, want 500)`);

  const unauthenticated = await infoStatus(() => null);
  ok(unauthenticated.status === 401, `an unauthenticated caller gets 401, not the info document (got ${unauthenticated.status})`);
}

// 2. OE's own authenticators against the split. Each one is an operator credential
//    (principalType "service"), so it passes the info access check, and none grants tool stubs.
{
  const entry: ServiceTokenEntry = { name: "ops-bot", sha256: createHash("sha256").update("svc-token-synthetic", "utf-8").digest("hex") };
  for (const [name, auth] of [
    ["serviceTokenAuth", serviceTokenAuth([entry])],
    ["injectTokenAuth", injectTokenAuth([entry])],
  ] as const) {
    const result = (await auth(new Request("https://agent.example/x", { headers: { authorization: "Bearer svc-token-synthetic" } }))) as
      | (Record<string, unknown> & { principalType?: string })
      | null
      | undefined;
    ok(result != null, `${name} authenticates its own token (so the checks below are not vacuous)`);
    ok(result?.principalType === "service", `${name} returns an operator principal (principalType "service")`);
    ok(result?.allowToolStubs === undefined && result?.allowAgentInfo === undefined, `${name} grants neither tool stubs nor an info override`);
    const viaChannel = await infoStatus(auth as EveAuthFn, { authorization: "Bearer svc-token-synthetic" });
    ok(viaChannel.status === 500, `${name} on an eve channel passes eve's info access check as an operator (got ${viaChannel.status}, want 500)`);
  }
}

// 3. OE grants neither permission anywhere, and authors no eve channel, so eve's default
//    channel (vercelOidc, localDev, placeholderAuth) decides who reads info.
{
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const roots = ["agent", "packages/core/agent", "packages/adapters/agent", "packages/create/template/agent"];
  const providerRoots = readdirSync(join(repo, "packages/providers")).map((p) => `packages/providers/${p}/agent`);
  ok(providerRoots.length > 0, "the provider trees are listed — an empty list would skip them silently");
  // `oe build` writes each channel to `agent/channels/<name>.ts`, where `<name>` is the manifest
  // entry's name. So a manifest entry named "eve" would replace eve's default eve channel.
  const manifests = [
    "packages/core/agent/contributions.ts",
    "packages/adapters/agent/contributions.ts",
    ...providerRoots.map((r) => `${r}/contributions.ts`).filter((f) => existsSync(join(repo, f))),
  ];
  const channelNames: string[] = [];
  for (const file of manifests) {
    const mod = (await import(pathToFileURL(join(repo, file)).href)) as {
      readonly CONTRIBUTIONS: { readonly contributions: readonly { readonly kind: string; readonly name: string }[] };
    };
    for (const c of mod.CONTRIBUTIONS.contributions) if (c.kind === "channel") channelNames.push(c.name);
  }
  ok(channelNames.includes("unified"), `the manifests list channel contributions (read ${channelNames.length}, "unified" among them) — an empty read would pass vacuously`);
  ok(!channelNames.includes("eve"), `no contribution manifest declares a channel named "eve"`);
  const lock = JSON.parse(readFileSync(join(repo, "roster.lock.json"), "utf8")) as { readonly packages: Record<string, { readonly contributions?: Record<string, string> }> };
  const lockKeys = Object.values(lock.packages).flatMap((p) => Object.keys(p.contributions ?? {}));
  ok(lockKeys.includes("channel/unified"), "control: roster.lock.json lists channel contributions");
  ok(!lockKeys.includes("channel/eve"), "roster.lock.json holds no `channel/eve` contribution");

  for (const root of [...roots, ...providerRoots]) {
    // eve replaces its default eve channel with an authored `channels/eve.<ext>`, for any supported
    // module extension. The refusal of a `channels/eve/` directory is deliberately stricter than eve,
    // which reads a directory as a namespace.
    const channelsDir = join(repo, root, "channels");
    const eveEntries = existsSync(channelsDir) ? readdirSync(channelsDir).filter((n) => n === "eve" || /^eve\.[^.]+$/.test(n)) : [];
    ok(eveEntries.length === 0, `${root}/channels holds no eve channel module (found: ${eveEntries.join(", ")}) — OE authors no eve channel`);
  }
  const scanned: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(?:[cm]?[tj]s|[tj]sx)$/.test(name)) scanned.push(full);
    }
  };
  for (const root of [...roots, ...providerRoots]) walk(join(repo, root));
  ok(scanned.length > 100, `the scan reads the agent trees (read ${scanned.length} files) — an empty scan would pass vacuously`);
  const GRANT_RE = /\ballow(ToolStubs|AgentInfo)\b/;
  ok(GRANT_RE.test("return { ...p, allowAgentInfo: true }") && GRANT_RE.test("{ allowToolStubs: true }"), "control: the grant pattern matches a grant");
  const granting = scanned.filter((f) => GRANT_RE.test(readFileSync(f, "utf8")));
  ok(granting.length === 0, `no OE agent source grants allowToolStubs or allowAgentInfo (found: ${granting.join(", ")})`);
}

console.log(`✓ eve-info-access: ${passed} checks`);
