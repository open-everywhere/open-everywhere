import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentDisplayName, scmAppPermissionFloor, surfaceAppCreateFlow } from "@open-everywhere/core/agent/adapter-api.js";
import {
  EVENT_PERMISSION,
  GITHUB_APP_CREATE_FLOW,
  GITHUB_APP_NAME_MAX,
  exchangeGithubManifestCode,
  githubAppEnvNames,
  githubAppEvents,
  githubAppManifest,
  githubAppPermissions,
  githubAppSettings,
} from "../agent/app-manifest.js";
import { GITHUB_PROVIDER_EVENTS } from "../agent/provider-events.js";
import { registerGithubOps } from "../agent/ops.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

ok(surfaceAppCreateFlow("github") === undefined, "before registerGithubOps() no github flow is registered");
registerGithubOps();
ok(surfaceAppCreateFlow("github") === GITHUB_APP_CREATE_FLOW, "registerGithubOps() registers the GitHub App create flow");

{
  const routed = GITHUB_PROVIDER_EVENTS.events.filter((e) => e.routing !== "none").map((e) => e.event);
  const unmapped = routed.filter((e) => EVENT_PERMISSION[e] === undefined);
  ok(unmapped.length === 0, `🔴 every routed inventory event names the permission it needs (missing: ${unmapped.join(", ") || "none"})`);
  const full = githubAppEvents("full");
  ok(JSON.stringify(full) === JSON.stringify([...routed].sort()), "the full App subscribes to every routed inventory event");
  ok(!full.includes("installation"), "an unroutable event (installation) is not subscribed — GitHub sends it anyway");
  ok(full.includes("issue_comment") && full.includes("pull_request_review_comment"), "the mention events are subscribed");
  ok(githubAppEvents("source-control").length === 0, "the source-control App subscribes to no event");
}

{
  const floor = scmAppPermissionFloor();
  for (const variant of ["full", "source-control"] as const) {
    const perms = githubAppPermissions(variant);
    for (const [family, grade] of Object.entries(floor)) {
      ok(perms[family] === "write" || perms[family] === grade, `${variant}: the App holds the mint floor's ${family}=${grade}`);
    }
    for (const event of githubAppEvents(variant)) {
      ok(perms[EVENT_PERMISSION[event]!] !== undefined, `${variant}: the App holds the ${EVENT_PERMISSION[event]} permission the ${event} event needs`);
    }
  }
  ok(
    JSON.stringify(githubAppPermissions("full")) ===
      JSON.stringify({ actions: "read", checks: "read", contents: "write", issues: "write", metadata: "read", pull_requests: "write" }),
    "the full App's permissions, exactly",
  );
  ok(JSON.stringify(githubAppPermissions("source-control")) === JSON.stringify(floor), "the source-control App holds the mint floor and nothing else");
  ok(githubAppPermissions("full").workflows === undefined, "no opt-in capability family is granted by default");
}

{
  const m = githubAppManifest({ host: "oe.example.com", variant: "full", redirectUrl: "http://127.0.0.1:5555/callback" });
  const hook = m.hook_attributes as { url: string; active: boolean };
  ok(hook.url === "https://oe.example.com/eve/v1/github" && hook.active === true, "the webhook points at this deployment's GitHub route, active");
  ok(m.url === "https://oe.example.com", "the homepage is the deployment");
  ok(m.redirect_url === "http://127.0.0.1:5555/callback", "the redirect is the local catch page");
  ok(m.public === false, "the App is private to its owner");
  ok(m.name === agentDisplayName(), "no name passed: the deployment's display name (identity.name, else the shipped one)");
  ok(githubAppManifest({ host: "h", variant: "full", redirectUrl: "r", appName: "Acme Agent" }).name === "Acme Agent", "an explicit name wins");
  ok(String(githubAppManifest({ host: "h", variant: "full", redirectUrl: "r", appName: "x".repeat(50) }).name).length === GITHUB_APP_NAME_MAX, "a name never exceeds GitHub's limit");
  const sc = githubAppManifest({ host: "oe.example.com", variant: "source-control", redirectUrl: "r" });
  ok((sc.hook_attributes as { active: boolean }).active === true, "the source-control App keeps its webhook: installs register themselves through it");
  ok(JSON.stringify(sc.default_events) === "[]", "the source-control manifest subscribes to nothing");
  const viaFlow = GITHUB_APP_CREATE_FLOW.manifest({ host: "oe.example.com", variant: "full", redirectUrl: "http://127.0.0.1:5555/callback" });
  ok(JSON.stringify(viaFlow) === JSON.stringify(m), "the flow serves the same manifest");
}

{
  const f = GITHUB_APP_CREATE_FLOW;
  ok(f.createUrl({ state: "s1" }) === "https://github.com/settings/apps/new?state=s1", "no owner: the person's own account");
  ok(f.createUrl({ owner: "acme-co", state: "s1" }) === "https://github.com/organizations/acme-co/settings/apps/new?state=s1", "an owner: that organization");
  ok(f.ownerProblem("acme-co") === undefined && f.ownerProblem("Acme2") === undefined, "a GitHub login passes");
  for (const bad of ["-acme", "acme-", "ac--me", "acme/x", "a".repeat(40), ""]) ok(f.ownerProblem(bad) !== undefined, `an owner that is not a login is refused: "${bad}"`);
  ok(f.codeProblem("0a1b2c3d4e") === undefined, "a GitHub code passes");
  for (const bad of ["", "../app-manifests", "a b", "a?b=c"]) ok(f.codeProblem(bad) !== undefined, `a code that could change the URL is refused: "${bad}"`);
  ok(f.variants[0]?.name === "full", "the full App is the default shape");
  ok(JSON.stringify(f.envNames("full")) === JSON.stringify(githubAppEnvNames("full")), "the flow checks the names it writes");
}

{
  const PEM = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n";
  const conversion = { id: 1234, slug: "acme-agent", name: "Acme Agent", pem: PEM, webhook_secret: "whsec", client_id: "Iv1.abc", client_secret: "cs" };
  const calls: { url: string; method: string }[] = [];
  const fake =
    (opts: { conversionStatus?: number; body?: object; bot?: "ok" | "404" | "throw" } = {}): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/app-manifests/")) {
        const status = opts.conversionStatus ?? 201;
        return new Response(JSON.stringify(opts.body ?? conversion), { status });
      }
      if (opts.bot === "throw") throw new Error("offline");
      if (opts.bot === "404") return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ id: 99887766, login: "acme-agent[bot]" }), { status: 200 });
    }) as typeof fetch;

  const full = await exchangeGithubManifestCode({ code: "abc123", variant: "full", fetchFn: fake() });
  ok(calls[0]?.url === "https://api.github.com/app-manifests/abc123/conversions" && calls[0]?.method === "POST", "the code goes to GitHub's conversion endpoint");
  ok(calls[1]?.url === "https://api.github.com/users/acme-agent%5Bbot%5D", "the bot user is read by its public login");
  ok(JSON.stringify(Object.keys(full.env).sort()) === JSON.stringify([...githubAppEnvNames("full")].sort()), "the full App fills every name it declares");
  ok(full.env.GITHUB_APP_PRIVATE_KEY === PEM && full.env.OE_GITHUB_APP_PRIVATE_KEY === undefined, "the key fills both planes under ONE name (OPE-2650 folded OE_GITHUB_APP_PRIVATE_KEY into it)");
  ok(full.env.GITHUB_WEBHOOK_SECRET === "whsec", "the webhook secret");
  for (const name of ["OE_GITHUB_APP_ID", "GITHUB_APP_ID", "OE_GITHUB_APP_SLUG", "GITHUB_APP_SLUG", "OE_GITHUB_APP_CLIENT_ID", "OE_GITHUB_BOT_USER_ID"]) {
    ok(!(name in full.env), `🔴 the exchange writes no ${name} to env: the App's ids are settings (OPE-2650)`);
  }
  ok(
    JSON.stringify(full.settings) ===
      JSON.stringify({ "github.appId": "1234", "github.appSlug": "acme-agent", "github.appClientId": "Iv1.abc", "github.botUserId": "99887766", "github.conversation": true }),
    "the exchange returns the App id, slug, client id and bot user id as github.* settings, and arms the conversation surface for the full App",
  );
  ok(
    JSON.stringify(full.settings) === JSON.stringify(githubAppSettings({ variant: "full", id: "1234", slug: "acme-agent", clientId: "Iv1.abc", botUserId: "99887766" })),
    "the exchange's settings are githubAppSettings of the converted App",
  );
  ok(!Object.values(full.env).includes("cs") && !Object.values(full.settings ?? {}).includes("cs"), "the client secret is not stored: nothing reads it");
  ok(full.appName === "Acme Agent" && full.installUrl === "https://github.com/apps/acme-agent/installations/new", "the app's name and install link");

  const sc = await exchangeGithubManifestCode({ code: "abc123", variant: "source-control", fetchFn: fake() });
  ok(sc.env.GITHUB_APP_PRIVATE_KEY === PEM, "source control only: the one private key");
  ok(sc.settings?.["github.conversation"] === false, "🔴 OPE-2650: a source-control App does not arm the conversation surface (github.conversation: false)");
  ok(sc.env.GITHUB_WEBHOOK_SECRET === "whsec", "…but the webhook secret, which install self-registration verifies with");
  const { ["github.conversation"]: _scArm, ...scIds } = sc.settings ?? {};
  const { ["github.conversation"]: _fullArm, ...fullIds } = full.settings ?? {};
  ok(JSON.stringify(scIds) === JSON.stringify(fullIds), "both shapes return the same github.* ids: one App id and one slug serve both planes; only github.conversation differs");

  const noBot = await exchangeGithubManifestCode({ code: "abc123", variant: "full", fetchFn: fake({ bot: "throw" }) });
  ok(noBot.settings !== undefined && !("github.botUserId" in noBot.settings) && noBot.settings["github.appId"] === "1234", "a failed bot lookup is fail-soft");
  const bot404 = await exchangeGithubManifestCode({ code: "abc123", variant: "full", fetchFn: fake({ bot: "404" }) });
  ok(bot404.settings !== undefined && !("github.botUserId" in bot404.settings), "a missing bot user writes no id");

  const refused = await exchangeGithubManifestCode({ code: "abc123", variant: "full", fetchFn: fake({ conversionStatus: 404, body: { message: "secret-echo" } }) }).then(
    () => undefined,
    (e: Error) => e.message,
  );
  ok(refused !== undefined && refused.includes("HTTP 404") && !refused.includes("secret-echo"), "a refusal names the status, never the body");
  const notJson = (async () => new Response("leak-echo", { status: 201 })) as unknown as typeof fetch;
  const garbled = await exchangeGithubManifestCode({ code: "abc123", variant: "full", fetchFn: notJson }).then(
    () => undefined,
    (e: Error) => e.message,
  );
  ok(garbled !== undefined && garbled.includes("not JSON") && !garbled.includes("leak-echo"), "a body that is not JSON is refused with a fixed message, never a fragment of it");
  const partial = await exchangeGithubManifestCode({ code: "abc123", variant: "full", fetchFn: fake({ body: { ...conversion, pem: undefined } }) }).then(
    () => undefined,
    (e: Error) => e.message,
  );
  ok(partial !== undefined && partial.includes("pem"), "a reply without a key is refused, naming the missing field");
}

{
  for (const variant of ["source-control", "full"] as const) {
    ok(
      JSON.stringify(githubAppEnvNames(variant)) === JSON.stringify(["GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"]),
      `🔴 the ${variant} App's env names are its two secrets only`,
    );
  }
  ok(
    JSON.stringify(githubAppSettings({ variant: "source-control", id: "7", slug: "s", clientId: "Iv1.x" })) ===
      JSON.stringify({ "github.appId": "7", "github.appSlug": "s", "github.appClientId": "Iv1.x", "github.conversation": false }),
    "githubAppSettings maps the id, slug and client id, writes no bot user id it was not given, and leaves a source-control App's conversation surface off",
  );
  ok(githubAppSettings({ variant: "full", id: "7", slug: "s", clientId: "Iv1.x", botUserId: "42" })["github.botUserId"] === "42", "githubAppSettings maps a given bot user id");
  ok(githubAppSettings({ variant: "full", id: "7", slug: "s", clientId: "Iv1.x" })["github.conversation"] === true, "🔴 OPE-2650: only the full App arms the conversation surface");
}

{
  const after = GITHUB_APP_CREATE_FLOW.after;
  const pushAt = after.findIndex((l) => /(push|store) each written name/i.test(l) && /redeploy/i.test(l));
  const installAt = after.findIndex((l) => /install the app on the repositories/i.test(l));
  ok(pushAt >= 0 && installAt >= 0, "the manifest flow's next steps name both the env push and the install");
  ok(pushAt < installAt, "🔴 the manifest flow's next steps push the env and redeploy BEFORE the install");

  const root = new URL("../../../../", import.meta.url);
  const read = (rel: string) => readFileSync(new URL(rel, root), "utf8");
  const section = (text: string, from: string, to?: string) => {
    const a = text.indexOf(from);
    assert.ok(a >= 0, `section start "${from}" is present`);
    const b = to === undefined ? -1 : text.indexOf(to, a + from.length);
    return text.slice(a, b < 0 ? undefined : b);
  };
  const order = (label: string, text: string, redeploy: RegExp, install: RegExp) => {
    const r = text.search(redeploy);
    const i = text.search(install);
    ok(r >= 0 && i >= 0, `${label}: names both the redeploy and the install`);
    ok(r < i, `🔴 ${label}: the redeploy comes BEFORE the install`);
  };
  order(
    "docs/deploy/surfaces/github.md § Setup",
    section(read("docs/deploy/surfaces/github.md"), "## Setup", "## Multi-org"),
    /then redeploy/,
    /\*\*Install the App\*\*/,
  );
  order(
    "docs/deploy/agent-driven-setup.md (the GitHub App step)",
    section(read("docs/deploy/agent-driven-setup.md"), "For GitHub, the App is one click", "**Which surfaces generate their app.**"),
    /redeploy/,
    /install the App on the repositories/,
  );
  for (const skill of [".claude/skills/quickstart-open-everywhere/SKILL.md", "packages/create/template/claude/skills/quickstart-open-everywhere/SKILL.md"]) {
    order(
      `${skill} (the GitHub App steps)`,
      section(read(skill), "Offer this step after the first deploy, when the user wants the agent to work in GitHub", "The tool never returns a secret"),
      /and redeploy/,
      /install the App/,
    );
  }
}

console.log(`✓ github-app-manifest: ${n} assertions passed`);
