import assert from "node:assert/strict";
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
  ok(full.env.OE_GITHUB_APP_ID === "1234" && full.env.GITHUB_APP_ID === "1234", "the App id fills both planes");
  ok(full.env.OE_GITHUB_APP_PRIVATE_KEY === PEM && full.env.GITHUB_APP_PRIVATE_KEY === PEM, "the key fills both planes");
  ok(full.env.GITHUB_WEBHOOK_SECRET === "whsec" && full.env.OE_GITHUB_APP_CLIENT_ID === "Iv1.abc", "the webhook secret and the client id");
  ok(full.env.OE_GITHUB_BOT_USER_ID === "99887766", "the bot user id, for the commit e-mail");
  ok(!Object.values(full.env).includes("cs"), "the client secret is not stored: nothing reads it");
  ok(full.appName === "Acme Agent" && full.installUrl === "https://github.com/apps/acme-agent/installations/new", "the app's name and install link");

  const sc = await exchangeGithubManifestCode({ code: "abc123", variant: "source-control", fetchFn: fake() });
  ok(sc.env.GITHUB_APP_ID === undefined && sc.env.GITHUB_APP_PRIVATE_KEY === undefined, "source control only: no conversational names");
  ok(sc.env.GITHUB_WEBHOOK_SECRET === "whsec", "…but the webhook secret, which install self-registration verifies with");

  const noBot = await exchangeGithubManifestCode({ code: "abc123", variant: "full", fetchFn: fake({ bot: "throw" }) });
  ok(noBot.env.OE_GITHUB_BOT_USER_ID === undefined && noBot.env.OE_GITHUB_APP_ID === "1234", "a failed bot lookup is fail-soft");
  const bot404 = await exchangeGithubManifestCode({ code: "abc123", variant: "full", fetchFn: fake({ bot: "404" }) });
  ok(bot404.env.OE_GITHUB_BOT_USER_ID === undefined, "a missing bot user writes no id");

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

console.log(`✓ github-app-manifest: ${n} assertions passed`);
