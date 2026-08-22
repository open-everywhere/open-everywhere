import assert from "node:assert/strict";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const { githubWorkMount } = await import("../agent/scm/github-work.js");
type BindableContext = import("../agent/identity/binding.js").BindableContext;
ok(
  githubWorkMount({} as unknown as BindableContext) === true,
  "🔴 FAIL-OPEN: with no app config registered the mount predicate answers TRUE (the repo fence at execute is the wall)",
);

const { registerConfig } = await import("../agent/access/config.js");
const { defineBundle, defineBinding } = await import("../agent/access/bundle.js");
const { defineDomain } = await import("../agent/memory/domain.js");
const { registerIdentityMapper } = await import("../agent/identity/binding.js");
type Domain = import("../agent/memory/domain.js").Domain;

const CHAT = "testchat";
registerIdentityMapper(CHAT, (ctx) => {
  const a = (ctx as BindableContext).session?.auth?.current?.attributes as Record<string, string> | undefined;
  return { workspace: a?.["ws"], surface: a?.["room"], mode: "channel", visibility: "public", trust: "internal", principalId: "U_TEST" };
});

function chatCtx(room: string, grain = "task"): BindableContext {
  return {
    channel: { kind: CHAT },
    session: {
      id: `sess-${room}-${grain}`,
      auth: { current: { attributes: { ws: "W1", room, oe_grain: grain }, principalId: "U_TEST", principalType: "test-user" } },
    },
  } as unknown as BindableContext;
}

const PAY_ROOM = `${CHAT}/W1/CPAY`;
const ENG_ROOM = `${CHAT}/W1/CENG`;

const PAY_REPO_ROOM = "github/W1/api";
const ENG_REPO_ROOM = "github/W1/other";

const DOMAINS: readonly Domain[] = [
  defineDomain({ name: "payments", channels: [PAY_ROOM, PAY_REPO_ROOM] }),
  defineDomain({ name: "eng", channels: [ENG_ROOM, ENG_REPO_ROOM] }),
];

registerConfig({
  loadBundles: () => [defineBundle({ name: "coding", repos: ["acme/api"] })],
  loadBindings: () => [defineBinding({ bundle: "coding", scope: { level: "domain", domain: "payments" } })],
  pluginRegistry: {},
  skillContent: {},
  loadDomains: () => DOMAINS,
  loadSilos: () => [],
  domainsForSurface: ({ workspaceKey, surface }) => {
    const key = `${workspaceKey}/${surface}`;
    return DOMAINS.filter((d) => (d.channels ?? []).includes(key)).map((d) => d.name);
  },
});

const { resolveAccessFor } = await import("../agent/access/request.js");

ok(resolveAccessFor(chatCtx("CPAY")).repos.join(",") === "acme/api", "FIXTURE: the granted room resolves the repo grant");
ok(resolveAccessFor(chatCtx("CENG")).repos.length === 0, "FIXTURE: the control room resolves NO repo grant");

const { resolveWindowGated } = await import("../agent/access/window-gated.js");
const gated = {
  checkout_repo: (await import("../agent/tools/checkout_repo.js")).default,
  open_pull_request: (await import("../agent/tools/open_pull_request.js")).default,
};

for (const [name, tool] of Object.entries(gated)) {
  ok((await resolveWindowGated(tool, chatCtx("CPAY"))) !== null, `${name} MOUNTS for a seat whose scope grants a repo`);
  ok(
    (await resolveWindowGated(tool, chatCtx("CENG"))) === null,
    `🔴 THE FIX: ${name} is ABSENT for a seat with NO repo grant (it used to mount and refuse at execute)`,
  );
  ok(
    (await resolveWindowGated(tool, chatCtx("CPAY", "standing"))) === null,
    `NEGATIVE CONTROL: ${name} stays absent on a STANDING seat that holds the repo grant (grain first, grant second)`,
  );
}

type DynamicToolModule = { readonly default: { readonly events: Record<string, (event: unknown, ctx: BindableContext) => unknown> } };

async function resolveDynamic(slug: string, ctx: BindableContext): Promise<unknown> {
  const mod = (await import(`../agent/tools/${slug}.js`)) as DynamicToolModule;
  const resolver = mod.default.events["session.started"];
  ok(typeof resolver === "function", `${slug} exports a session.started resolver`);
  return resolver({}, ctx);
}

const UNGATED_GITHUB_TOOLS = ["check_pr_status", "get_pr_feedback", "walk_pr", "post_pr_walkthrough", "subscribe_pr"] as const;

for (const slug of UNGATED_GITHUB_TOOLS) {
  ok((await resolveDynamic(slug, chatCtx("CPAY"))) !== null, `${slug} MOUNTS for a seat whose scope grants a repo`);
  ok(
    (await resolveDynamic(slug, chatCtx("CENG"))) === null,
    `🔴 THE FIX (OPE-960): ${slug} is ABSENT for a seat with NO repo grant (it used to mount and refuse at execute)`,
  );
  ok(
    (await resolveDynamic(slug, chatCtx("CPAY", "standing"))) !== null,
    `${slug} still mounts on a STANDING seat that holds the grant (it is window-UNGATED — the grant is its only mount rule)`,
  );
}

const { workDestinationPlatforms } = await import("../agent/channels/work-destinations.js");
{
  const granted = workDestinationPlatforms(chatCtx("CPAY"), DOMAINS);
  ok(granted.includes("github"), "🔴 THE FIX: a repo-granted domain may address github with NO github chat channel anywhere in it");
  ok(
    granted.includes(CHAT) === false,
    "🔴 OPE-953: the window's OWN chat platform is NOT a destination — the set is the grant alone (explicit false)",
  );

  const ungranted = workDestinationPlatforms(chatCtx("CENG"), DOMAINS);
  ok(ungranted.includes("github") === false, "NEGATIVE CONTROL: a domain with no repo grant may not address github (explicit false)");
  ok(ungranted.length === 0, "…and it addresses nothing at all — a chat room confers no work destination");

  ok(
    workDestinationPlatforms({} as unknown as BindableContext, DOMAINS).includes("github") === false,
    "an identity-less ctx resolves NO grant here (the destination set fails closed, it does not throw)",
  );
}

const { assembleAccessInstructions } = await import("../agent/access/instructions.js");
{
  const rendered = assembleAccessInstructions(resolveAccessFor(chatCtx("CPAY")), [DOMAINS[0]]) ?? "";
  ok(/Work surfaces your domain is granted: `github`/.test(rendered), "🔴 the work line names github when the session holds a repo grant");
  ok(rendered.includes("Repositories granted: `acme/api`"), "…alongside the repo list the same section already carried");

  const control = assembleAccessInstructions(resolveAccessFor(chatCtx("CENG")), [DOMAINS[1]]) ?? "";
  ok(control.includes("Work surfaces your domain is granted") === false, "NEGATIVE CONTROL: no repo grant, no work line — the prompt claims nothing");
}

{
  const { repoAllowed } = await import("../agent/scm/provider.js");
  const access = resolveAccessFor(chatCtx("CPAY"));
  ok(repoAllowed("acme/api", access.repos), "the granted repo passes the execute-time fence");
  ok(repoAllowed("evil/repo", access.repos) === false, "🔴 an ungranted repo is still refused at execute, in the room that MOUNTS the tool");
}

{
  const { routineFireAttributes } = await import("../agent/routines/fire-auth.js");
  type Routine = import("../agent/routines/routine.js").Routine;

  function fireCtx(room: string): BindableContext {
    const routine = {
      id: "r-pr-sub",
      org: "default",
      surfaceKey: `${CHAT}/W1/${room}`,
      promptGeneration: 1,
      sessionMode: "fresh",
    } as unknown as Routine;
    const attributes = routineFireAttributes(routine, { ws: "W1", room }, "channel", false);
    return {
      channel: { kind: CHAT },
      session: { id: `fire-${room}`, auth: { current: { attributes, principalId: "eve:app", principalType: "app" } } },
    } as unknown as BindableContext;
  }

  ok(resolveAccessFor(fireCtx("CPAY")).repos.join(",") === "acme/api", "FIXTURE: an unattended fire in the granted room resolves the repo grant");
  ok(resolveAccessFor(fireCtx("CENG")).repos.length === 0, "FIXTURE: an unattended fire in the control room resolves NO repo grant");

  for (const slug of UNGATED_GITHUB_TOOLS) {
    ok(
      (await resolveDynamic(slug, fireCtx("CPAY"))) !== null,
      `🔴 LIVE SUBSCRIPTION: ${slug} still mounts on an UNATTENDED FIRE in the granted room (a fire that lost it would end the chain silently)`,
    );
    ok(
      (await resolveDynamic(slug, fireCtx("CENG"))) === null,
      `NEGATIVE CONTROL: ${slug} is absent on a fire in a room with no repo grant (explicit null, not a refusal)`,
    );
  }
}

{
  const { surfaceWorkRole, domainHoldsSurfaceWorkGrant, surfaceWorkReadPlatforms, surfaceWorkReadMount, assertSurfaceWorkGrant, SurfaceWorkGrantError } =
    await import("../agent/access/surface-work-grant.js");

  registerIdentityMapper("github", (ctx) => {
    const a = (ctx as BindableContext).session?.auth?.current?.attributes as Record<string, string> | undefined;
    return { workspace: a?.["ws"], surface: a?.["repo"], mode: "channel", visibility: "private", trust: "internal", principalId: "U_GH" };
  });

  function githubCtx(repo: string): BindableContext {
    return {
      channel: { kind: "github" },
      session: { id: `gh-${repo}`, auth: { current: { attributes: { ws: "W1", repo }, principalId: "U_GH", principalType: "github-user" } } },
    } as unknown as BindableContext;
  }

  ok(resolveAccessFor(githubCtx("api")).repos.join(",") === "acme/api", "FIXTURE: the granted repo room resolves the repo grant");
  ok(resolveAccessFor(githubCtx("other")).repos.length === 0, "FIXTURE: the control repo room resolves NO repo grant");

  ok(surfaceWorkRole("github") === undefined, "github still declares no chat work role — the arm is not a WORK_ROLES row (OPE-940 stands)");
  ok(domainHoldsSurfaceWorkGrant(undefined, "github", ["acme/api"]) === true, "🔴 THE FIX: a repo grant IS github's chat-surface work grant, with no domain declaration");
  ok(domainHoldsSurfaceWorkGrant(undefined, "github", []) === false, "NEGATIVE CONTROL: no repos, no grant (explicit false)");
  ok(domainHoldsSurfaceWorkGrant(DOMAINS[0], "github") === false, "a caller that passes no repo grant holds none — the default is a refusal, not the domain");

  ok(surfaceWorkReadPlatforms(githubCtx("api"), DOMAINS).join(",") === "github", "a repo-granted github window reads its own surface on the work plane");
  ok(surfaceWorkReadMount(githubCtx("api"), () => DOMAINS) === true, "…and the work reads MOUNT there");
  ok(surfaceWorkReadPlatforms(githubCtx("other"), DOMAINS).length === 0, "NEGATIVE CONTROL: an ungranted repo room reads nothing (explicit empty)");
  ok(surfaceWorkReadMount(githubCtx("other"), () => DOMAINS) === false, "…and the work reads do NOT mount there (explicit false)");
  ok(surfaceWorkReadMount({} as unknown as BindableContext, () => DOMAINS) === false, "an identity-less ctx mounts nothing (fail closed)");

  assertSurfaceWorkGrant(githubCtx("api"), DOMAINS, "github");
  n++;
  assert.throws(
    () => assertSurfaceWorkGrant(githubCtx("other"), DOMAINS, "github"),
    (err: unknown) => err instanceof SurfaceWorkGrantError && err.platform === "github" && /repos:/.test(err.message),
    "an ungranted repo room is refused, and the message names the access bundle's repos: list, not a credentials role",
  );
  n++;

  ok(
    surfaceWorkReadPlatforms(chatCtx("CPAY"), DOMAINS).length === 0,
    "🔴 the repo grant confers NO work read on the chat platform in the same domain (explicit empty)",
  );
  ok(
    domainHoldsSurfaceWorkGrant(DOMAINS[0], CHAT, ["acme/api"]) === false,
    "…and a repo grant is not a credential-declared surface's grant either (explicit false)",
  );
}

console.log(`✓ github-work-grant: ${n} assertions passed`);
