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

const DOMAINS: readonly Domain[] = [
  defineDomain({ name: "payments", channels: [PAY_ROOM] }),
  defineDomain({ name: "eng", channels: [ENG_ROOM] }),
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

const { workDestinationPlatforms } = await import("../agent/channels/work-destinations.js");
{
  const granted = workDestinationPlatforms(chatCtx("CPAY"), DOMAINS);
  ok(granted.includes("github"), "🔴 THE FIX: a repo-granted domain may address github with NO github chat channel anywhere in it");
  ok(granted.includes(CHAT), "…and the window's own source is still in the set (the union never narrows)");

  const ungranted = workDestinationPlatforms(chatCtx("CENG"), DOMAINS);
  ok(ungranted.includes("github") === false, "NEGATIVE CONTROL: a domain with no repo grant may not address github (explicit false)");
  ok(ungranted.includes(CHAT), "…while its own source is unaffected");

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

console.log(`✓ github-work-grant: ${n} assertions passed`);
