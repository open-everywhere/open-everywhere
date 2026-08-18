import { readFileSync } from "node:fs";
import { renderScopeMarkdown } from "../../agent/instructions/access.js";
import { registerConfig } from "../../agent/access/config.js";
import { defineDomain } from "../../agent/memory/domain.js";
import { defineMemorySilo } from "../../agent/memory/silo.js";
import { registerSlackFixtureMapper, registerSlackFixtureManifest } from "../_slack-test-stubs.js";
import type { BindableContext } from "../../agent/identity/binding.js";

export const DOMAIN = "payments";
export const SLACK_CHANNEL = "C_PAY";
export const SLACK_TEAM = "T_PAY";

export function registerSyntheticConfig(opts: { readonly unified: boolean }): void {
  registerConfig({
    loadBundles: () => [],
    loadBindings: () => [],
    pluginRegistry: {},
    skillContent: {},
    loadDomains: () => [
      defineDomain({
        name: DOMAIN,
        channels: [`slack/${SLACK_TEAM}/${SLACK_CHANNEL}`, "notion/W_PAY/P_PAY", "github/acme/payments-api"],
        memory: "payments-notes",
        ambientSupervisor: true,
        ...(opts.unified ? { mode: "unified" as const } : {}),
      }),
      defineDomain({ name: "org", match: "org" }),
    ],
    loadSilos: () => [defineMemorySilo({ name: "payments-notes", description: "payments-domain decisions", provider: "sqlite" })],
    domainsForSurface: ({ surface }: { surface: string }) => ([SLACK_CHANNEL, "P_PAY", "payments-api"].includes(surface) ? [DOMAIN] : []),
  } as never);
  registerSlackFixtureMapper();
  registerSlackFixtureManifest();
}

export const unifiedCtx: BindableContext = {
  channel: { kind: "channel:unified", continuationToken: `oe-dom:${DOMAIN}:oe-sup:g1` },
  session: { auth: { current: { attributes: { oe_platform: "slack" } } } },
} as BindableContext;

export const perSurfaceCtx: BindableContext = {
  channel: { kind: "slack", continuationToken: `${SLACK_CHANNEL}:oe-sup:g1` },
  session: {
    auth: {
      current: {
        attributes: { team_id: SLACK_TEAM, channel_id: SLACK_CHANNEL, channel_type: "channel", is_private: "false", trust_checked: "true" },
        principalId: "U_ALEX",
        principalType: "user",
      },
    },
  },
} as BindableContext;

export function readBaseInstructions(): string {
  return readFileSync(new URL("../../../../agent/instructions.md", import.meta.url), "utf8");
}

export async function buildShippedSystemPrompt(
  ctx: BindableContext,
  patchBase?: (base: string) => string,
): Promise<string> {
  const raw = readBaseInstructions();
  const base = patchBase === undefined ? raw : patchBase(raw);
  return `${base}\n\n${await renderScopeMarkdown(ctx)}`;
}

export function markdownSection(md: string, heading: string): string {
  const i = md.indexOf(heading);
  if (i < 0) throw new Error(`the '${heading}' section is not in the file — an arm built from it would be a no-op reported as a swap`);
  const j = md.indexOf("\n## ", i + 1);
  return j < 0 ? md.slice(i) : md.slice(i, j + 1);
}

export function swapMarkdownSection(md: string, heading: string, replacement: string): string {
  const current = markdownSection(md, heading);
  const at = md.indexOf(current);
  if (md.indexOf(current, at + 1) >= 0) throw new Error(`the '${heading}' section appears twice — refusing an ambiguous swap`);
  return md.slice(0, at) + replacement + md.slice(at + current.length);
}
