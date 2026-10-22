import assert from "node:assert/strict";
import { pinSuiteStore } from "./_suite-store.js";
pinSuiteStore("public-url");
import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
registerSlackFixtureMapper();
import { registerConfig } from "../agent/access/config.js";
import { defineDomain, type Domain } from "../agent/memory/domain.js";
import type { BindableContext, SurfaceBinding } from "../agent/identity/binding.js";
import { pageBaseUrl } from "../agent/credentials/page-token.js";
import { selfDispatchBaseUrl } from "../agent/channels/self-dispatch.js";
import { oeOauthCallbackUrl, OE_OAUTH_CALLBACK_PATH } from "../agent/connections/oe-oauth-callback.js";
import { publicUrlAnswer, publicUrlDisclosed, publicUrlFacts, renderSeatPublicUrlSection } from "../agent/status/public-url.js";
import { renderScopeMarkdown } from "../agent/instructions/access.js";
import agentVersionTool from "../agent/tools/agent_version.js";
import { personTextFaults } from "../agent/channels/person-text.js";
import { dmAnchorWindowKey, formatWindowToken } from "../agent/channels/window-key.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

const CUSTOM = { OE_PUBLIC_BASE_URL: "agent.acme.example/", VERCEL_PROJECT_PRODUCTION_URL: "acme-oe.vercel.app", VERCEL_URL: "acme-oe-abc123.vercel.app" } as NodeJS.ProcessEnv;
const VERCEL = { VERCEL_PROJECT_PRODUCTION_URL: "acme-oe.vercel.app", VERCEL_URL: "acme-oe-abc123.vercel.app" } as NodeJS.ProcessEnv;
const PREVIEW = { VERCEL_URL: "acme-oe-abc123.vercel.app" } as NodeJS.ProcessEnv;
const NONE = {} as NodeJS.ProcessEnv;

{
  const custom = publicUrlFacts(CUSTOM);
  ok(custom.kind === "resolved" && custom.baseUrl === "https://agent.acme.example", `§1 🔴 OE_PUBLIC_BASE_URL wins over the Vercel variables (saw ${JSON.stringify(custom)})`);
  ok(custom.kind === "resolved" && custom.oauthCallbackUrl === "https://agent.acme.example/oauth/v1/callback", "§1 🔴 the callback is the custom domain plus the one callback path");
  ok(custom.kind === "resolved" && custom.source === "OE_PUBLIC_BASE_URL", "§1 the source is OE_PUBLIC_BASE_URL");

  const vercel = publicUrlFacts(VERCEL);
  ok(vercel.kind === "resolved" && vercel.oauthCallbackUrl === "https://acme-oe.vercel.app/oauth/v1/callback", `§1 🔴 with only the Vercel variables the production alias answers (saw ${JSON.stringify(vercel)})`);
  ok(vercel.kind === "resolved" && vercel.source === "VERCEL_PROJECT_PRODUCTION_URL", "§1 the production alias wins over the generated host");

  const preview = publicUrlFacts(PREVIEW);
  ok(preview.kind === "resolved" && preview.baseUrl === "https://acme-oe-abc123.vercel.app" && preview.source === "VERCEL_URL", "§1 the generated host is the last resort");

  ok(publicUrlFacts(NONE).kind === "none", "§1 🔴 with no variable set, no URL resolves");
  ok(publicUrlFacts({ OE_PUBLIC_BASE_URL: "   " } as NodeJS.ProcessEnv).kind === "none", "§1 a blank OE_PUBLIC_BASE_URL is no URL");

  for (const [label, env] of [["custom", CUSTOM], ["vercel", VERCEL], ["preview", PREVIEW], ["none", NONE]] as const) {
    const base = selfDispatchBaseUrl(env);
    ok(base === pageBaseUrl(env), `§1 🔴 ${label}: the self-dispatch resolver and the page resolver answer the same base`);
    ok(oeOauthCallbackUrl(env) === (base === undefined ? undefined : `${base}${OE_OAUTH_CALLBACK_PATH}`), `§1 🔴 ${label}: the OAuth callback the flow sends is that base plus the callback path`);
  }
}

{
  const resolved = renderSeatPublicUrlSection(publicUrlFacts(CUSTOM), true);
  ok(resolved.includes("https://agent.acme.example/oauth/v1/callback") && resolved.includes("Your web address: https://agent.acme.example"), "§2 🔴 the seat reads the full callback URL and the web address");
  ok(/Notion included/.test(resolved) && /one callback URL/.test(resolved) && /no separate callback per service/i.test(resolved), "§2 🔴 the seat reads one callback for every OAuth service, Notion named");
  ok(!/vercel/i.test(resolved), "§2 the block never names a credential home kind or a vendor connector");
  ok(!/changes with each deployment/.test(resolved), "§2 a custom domain carries no preview-host note");
  ok(/changes with each deployment/.test(renderSeatPublicUrlSection(publicUrlFacts(PREVIEW), true)), "§2 a generated host carries the note that it changes with each deployment");

  const none = renderSeatPublicUrlSection(publicUrlFacts(NONE), true);
  ok(/no public web address set/.test(none) && none.includes("OE_PUBLIC_BASE_URL") && none.includes("`/oauth/v1/callback`"), "§2 🔴 with none, the seat says so plainly and names the setting");
  ok(/Never write a placeholder host/.test(none) && !/https:\/\//.test(none), "§2 🔴 with none, the seat writes no host and is told never to write a placeholder");

  const hidden = renderSeatPublicUrlSection(publicUrlFacts(CUSTOM), false);
  ok(!/acme/.test(hidden) && !/https:\/\//.test(hidden), "§2 🔴 outside an internal room the block names no host");
  ok(/direct message or an internal channel/.test(hidden), "§2 outside an internal room the seat says where it gives the address");

  const a = publicUrlAnswer(publicUrlFacts(CUSTOM), true);
  ok(a.oauthCallbackUrl === "https://agent.acme.example/oauth/v1/callback" && a.baseUrl === "https://agent.acme.example", "§2 the worker's answer carries the same two URLs");
  ok(publicUrlAnswer(publicUrlFacts(CUSTOM), false).oauthCallbackUrl === undefined, "§2 🔴 the worker's answer names no URL outside an internal room");
  ok(/OE_PUBLIC_BASE_URL/.test(publicUrlAnswer(publicUrlFacts(NONE), true).forOperator ?? ""), "§2 the worker's none answer names the setting for an operator");
  ok(/OE_PUBLIC_BASE_URL/.test(publicUrlAnswer(publicUrlFacts(PREVIEW), true).forOperator ?? "") && publicUrlAnswer(publicUrlFacts(CUSTOM), true).forOperator === undefined, "§2 only a gap carries an operator step");
  for (const [label, d, env] of [["resolved", true, CUSTOM], ["preview", true, PREVIEW], ["none", true, NONE], ["hidden", false, CUSTOM]] as const) {
    const faults = personTextFaults(publicUrlAnswer(publicUrlFacts(env), d).note);
    ok(faults.length === 0, `§2 the ${label} note passes the person-text detector (saw ${JSON.stringify(faults)})`);
  }
}

{
  const b = (trust: "internal" | "external", roomTrust?: "internal" | "external") => ({ trust, ...(roomTrust !== undefined ? { roomTrust } : {}) }) as unknown as SurfaceBinding;
  ok(publicUrlDisclosed(b("internal")), "§3 an internal person in an internal room may read the URL");
  ok(!publicUrlDisclosed(b("external")), "§3 🔴 an external or unverified person may not");
  ok(!publicUrlDisclosed(b("internal", "external")), "§3 🔴 an internal person in an external room may not");
  ok(!publicUrlDisclosed(b("external", "internal")), "§3 🔴 an external person in an internal room may not");
}

{
  const domains: Domain[] = [defineDomain({ name: "org", match: "org", admins: ["slack/T1/U_ADMIN"] })];
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => domains,
    loadSilos: () => [],
    domainsForSurface: () => [],
  });
  const ctxOf = (attributes: Record<string, string>): BindableContext => ({
    channel: { kind: "slack" },
    session: { auth: { current: { principalId: "U_ASKER", principalType: "slack-user", attributes: { team_id: "T1", ...attributes } } } },
  });
  const internalDm = ctxOf({ channel_id: "D1", channel_type: "im", dm_partner_trust: "internal" });
  const unverifiedDm = ctxOf({ channel_id: "D2", channel_type: "im" });
  const internalRoom = ctxOf({ channel_id: "C1", channel_type: "channel", is_private: "false", trust_checked: "true", is_ext_shared: "false" });
  const externalRoom = ctxOf({ channel_id: "C2", channel_type: "channel", is_private: "false", trust_checked: "true", is_ext_shared: "true" });

  const saved = { a: process.env.OE_PUBLIC_BASE_URL, b: process.env.VERCEL_PROJECT_PRODUCTION_URL, c: process.env.VERCEL_URL };
  process.env.OE_PUBLIC_BASE_URL = "https://agent.acme.example";
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_URL;
  try {
    const CALLBACK = "https://agent.acme.example/oauth/v1/callback";
    const dm = await renderScopeMarkdown(internalDm);
    ok(dm.includes("### Your own address") && dm.includes(CALLBACK), "§4 🔴 the incident's own case: an internal DM seat prompt carries the full callback URL");
    ok(dm === (await renderScopeMarkdown(internalDm)), "§4 the block is byte-stable across turns");
    ok((await renderScopeMarkdown(internalRoom)).includes(CALLBACK), "§4 an internal channel seat prompt carries it too");
    const ext = await renderScopeMarkdown(externalRoom);
    ok(ext.includes("### Your own address") && !ext.includes("agent.acme.example"), "§4 🔴 an external channel seat prompt names no host");
    ok(!(await renderScopeMarkdown(unverifiedDm)).includes("agent.acme.example"), "§4 🔴 a DM whose partner is unverified names no host (fail closed)");

    const out = (await agentVersionTool.execute!({}, internalDm as never)) as { publicUrl?: { oauthCallbackUrl?: string; note: string } };
    ok(out.publicUrl?.oauthCallbackUrl === CALLBACK, `§4 🔴 agent_version returns the callback URL (saw ${JSON.stringify(out.publicUrl)})`);
    const outExt = (await agentVersionTool.execute!({}, externalRoom as never)) as { publicUrl?: { oauthCallbackUrl?: string } };
    ok(outExt.publicUrl !== undefined && outExt.publicUrl.oauthCallbackUrl === undefined, "§4 🔴 agent_version names no URL in an external room");

    const crossSurface = (attributes: Record<string, string>): BindableContext => ({
      channel: { kind: "channel:unified", continuationToken: "oe-dom:payments:oe-sup:g1" },
      session: { auth: { current: { principalId: "U_ASKER", principalType: "slack-user", attributes: { oe_platform: "slack", team_id: "T1", ...attributes } } } },
    });
    const crossIn = await renderScopeMarkdown(crossSurface({ channel_id: "C1", channel_type: "channel", is_private: "false", trust_checked: "true", is_ext_shared: "false" }));
    const crossOut = await renderScopeMarkdown(crossSurface({ channel_id: "C2", channel_type: "channel", is_private: "false", trust_checked: "true", is_ext_shared: "true" }));
    ok(crossIn.includes("### Your own address") && !crossIn.includes("agent.acme.example"), "§5 🔴 a cross-surface window names no host, even on an internal delivery");
    ok(crossIn === crossOut, "§5 🔴 a cross-surface window renders the same bytes for an internal and an external delivery");
    ok(/This window serves several conversations/.test(crossIn) && !/outside the organisation/.test(crossIn), "§5 a cross-surface window reads its own line, not the external-room line");

    const dmAnchor: BindableContext = {
      channel: { kind: "channel:unified", continuationToken: formatWindowToken(dmAnchorWindowKey("slack/T1/D1")) },
      session: { auth: { current: { principalId: "U_ASKER", principalType: "slack-user", attributes: { oe_platform: "slack", team_id: "T1", channel_id: "D1", channel_type: "im", dm_partner_trust: "internal" } } } },
    };
    const anchored = await renderScopeMarkdown(dmAnchor);
    ok(anchored.includes(CALLBACK), "§5 🔴 a DM-anchor window (the incident's DM path when windowed) names the callback to an internal partner");

    delete process.env.OE_PUBLIC_BASE_URL;
    const bare = await renderScopeMarkdown(internalDm);
    ok(bare.includes("no public web address set") && bare.includes("OE_PUBLIC_BASE_URL"), "§4 🔴 with no variable set, the seat prompt says so and names the setting");
  } finally {
    for (const [k, v] of [["OE_PUBLIC_BASE_URL", saved.a], ["VERCEL_PROJECT_PRODUCTION_URL", saved.b], ["VERCEL_URL", saved.c]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

console.log(`public-url-test: ${n} assertions passed`);
