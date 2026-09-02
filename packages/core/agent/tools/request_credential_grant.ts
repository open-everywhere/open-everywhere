import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { getConfig } from "../access/config.js";
import { CONVERSATIONAL_ROOT_GRAINS } from "../access/window-gate-manifest.js";
import { credentialGrantRefusalNote, resolveGrantOwner } from "../access/credential-grant-ask.js";
import type { GrantAskWorkerOrigin } from "../access/credential-grant-card.js";
import { askForCredentialGrant } from "../access/credential-grant-flow.js";
import { resolveRequesterLabel } from "../access/credential-grant-notice.js";
import { credentialGrantConnectors, domainsAdmitCredentialGrant } from "../access/credential-grant.js";
import { requesterThisTurn } from "../access/requester-identity.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import { resolveReplyTarget } from "../channels/reply-post.js";
import { configuredAgentName } from "../identity/bot-name.js";
import { currentSessionId, currentTurnId, delegationRootSessionId, isSubagentChildContext, windowGrainOf, type BindableContext } from "../identity/binding.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { resolvePartition } from "../memory/partition.js";
import type { Domain } from "../memory/domain.js";

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

function domainsForCtx(ctx: BindableContext): readonly Domain[] {
  try {
    const p = resolvePartition(ctx);
    const names = new Set(getConfig().domainsForSurface({ surface: p.surface ?? p.surfaceKey, workspaceKey: p.workspaceKey }));
    return safeDomains().filter((d) => names.has(d.name));
  } catch {
    return [];
  }
}

export function requestCredentialGrantMount(ctx: BindableContext): boolean {
  try {
    if (!mayRaiseGrantAsk(ctx)) return false;
  } catch {
    return false;
  }
  const domains = domainsForCtx(ctx);
  if (domains.length === 0) return false;
  for (const connector of credentialGrantConnectors()) if (domainsAdmitCredentialGrant(domains, connector)) return true;
  return false;
}

export function mayRaiseGrantAsk(ctx: BindableContext): boolean {
  if ((CONVERSATIONAL_ROOT_GRAINS as readonly string[]).includes(windowGrainOf(ctx))) return true;
  return isSubagentChildContext(ctx);
}

export function grantScopeKey(ctx: BindableContext): string {
  const root = delegationRootSessionId(ctx);
  if (root !== undefined) return root;
  if (ctx.session?.parent !== undefined || isSubagentChildContext(ctx)) return "";
  return currentSessionId(ctx) ?? "";
}

export const UNNAMED_SEAT_LABEL = "the assistant";

export const requestCredentialGrantEntry = defineTool({
  description:
    "Ask a named person to lend THIS conversation ONE tool from their own connector account — for " +
    "example one Notion page-reading tool, fixed to one page. They get a card in their own direct " +
    "messages and answer there; you get nothing back but confirmation that they were asked. Say in " +
    "the room that the ask went out, then carry on with something else; do not wait for an answer and " +
    "do not ask twice. When they approve, this conversation gains a tool on its next turn and the " +
    "answer is posted here. This grants nothing by itself.",
  inputSchema: z.object({
    connector: z
      .string()
      .min(1)
      .describe(`The vendor whose account would be spent. One of: ${credentialGrantConnectors().join(", ") || "(none — this deployment admits no credential grants)"}.`),
    frozen_args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "The arguments to FIX for this grant, as a JSON object — normally the one thing to read, such " +
          'as {"id": "<page id>"}. Anything you fix here you cannot change later: the granted tool shows ' +
          "each fixed argument with its one allowed value, and a call that sends anything else is refused. " +
          "Omit it only when the grant is genuinely meant to let this conversation choose every argument, " +
          "which is a much wider ask and the owner will see it described that way.",
      ),
    owner: z
      .string()
      .min(1)
      .describe(
        "The person whose credential would be spent. Either their full principal key (for example " +
          '"slack/T0AB1CD2E/U123ABC") or, for somebody on this same surface, their bare platform member id.',
      ),
    purpose: z
      .string()
      .min(1)
      .describe("Why you need it, in one sentence. They read this to decide, so say what you will do with it, not what you want."),
    requested_mode: z
      .enum(["once", "session", "standing"])
      .describe("What to ask for: one single call, this whole conversation, or a standing grant with an expiry. They choose the final answer."),
    target_label: z
      .string()
      .min(1)
      .describe(
        'What the thing you want to reach is CALLED, in plain words — for example "Quarterly report". It ' +
          "names the granted tool and it is what the owner reads on their card, so use the label a person " +
          "would recognise, not an id.",
      ),
    tool: z
      .string()
      .min(1)
      .describe(
        "The vendor's own tool name, spelled exactly as their connection publishes it (for example " +
          "`notion-fetch`). It is checked against their live connection when they approve, and an ask " +
          "that names a tool their account does not publish is refused then.",
      ),
  }),
  outputSchema: z.object({
    asked: z.boolean(),
    askId: z.string().optional(),
    owner: z.string().optional(),
    message: z.string(),
  }),
  async execute(input, ctx) {
    const c = ctx as BindableContext;
    if (untrustedIngestedThisTurn()) {
      return {
        asked: false,
        message:
          "Refused: this turn has already read external content, so it may not ask anyone for their credential. " +
          "The purpose line is the one thing the owner reads to judge the ask, and fetched content must never author it. " +
          "Ask again in a fresh turn that has read nothing external.",
      };
    }
    const known = credentialGrantConnectors();
    if (!known.includes(input.connector)) {
      return {
        asked: false,
        message:
          `Refused: "${input.connector}" is not a connector this deployment lends credentials for. ` +
          (known.length > 0 ? `It admits: ${known.join(", ")}.` : "It admits none, so nothing can be granted here."),
      };
    }
    const frozenArgs = input.frozen_args ?? {};
    const frozenProblem = jsonObjectProblem(frozenArgs);
    if (frozenProblem !== undefined) {
      return { asked: false, message: `Refused: the arguments to fix are not something a grant can hold — ${frozenProblem}. Send plain JSON values only.` };
    }
    if (!mayRaiseGrantAsk(c)) {
      return {
        asked: false,
        message:
          "Refused: this session is not a conversation, and it is not a task delegated from one, so there is nobody here whose chat a grant could be scoped to.",
      };
    }
    const p = resolvePartition(c);
    const domains = domainsForCtx(c);
    const scopeKey = grantScopeKey(c);
    if (scopeKey.length === 0) {
      return { asked: false, message: "Refused: this conversation has no session id, so there is no chat for a grant to be scoped to." };
    }
    const rootSessionId = delegationRootSessionId(c);
    const workerOrigin: GrantAskWorkerOrigin | undefined =
      rootSessionId === undefined ? undefined : { seatLabel: configuredAgentName() ?? UNNAMED_SEAT_LABEL };
    const verdict = requesterThisTurn(currentTurnId(c));
    const requesterPrincipalId = verdict.kind === "requester" ? tryPrincipalKey(p.platform, p.workspace, verdict.principalId) : undefined;

    const owner = await resolveGrantOwner(input.owner, p.platform, p.workspace);
    if ("refusal" in owner) return { asked: false, message: owner.refusal };

    const requesterLabel =
      requesterPrincipalId === undefined
        ? "an unverified caller"
        : (await resolveRequesterLabel(requesterPrincipalId).catch(() => undefined)) ?? requesterPrincipalId;
    const requesterTarget = replyTargetJson(c);

    const outcome = await askForCredentialGrant({
      connector: input.connector,
      domainGrantsConnector: domainsAdmitCredentialGrant(domains, input.connector),
      frozenArgs: frozenArgs,
      mcpTool: input.tool,
      nowMs: Date.now(),
      org: p.org,
      ownerHandle: owner.handle,
      ownerNativeId: owner.nativeId,
      ownerPlatform: owner.platform,
      ownerPrincipalId: owner.principalId,
      platform: p.platform,
      purpose: input.purpose,
      requestedMode: input.requested_mode,
      requesterLabel,
      requesterPrincipalId,
      ...(requesterTarget === undefined ? {} : { requesterTarget }),
      scopeKey,
      ...(p.surface === undefined ? {} : { surface: p.surface }),
      targetLabel: input.target_label,
      ...(workerOrigin === undefined ? {} : { workerOrigin }),
      workspace: p.workspace,
    });

    if (!outcome.sent) return { asked: false, message: credentialGrantRefusalNote(input.connector, outcome.reason) };
    return {
      askId: outcome.askId,
      asked: true,
      message:
        `Asked ${outcome.ownerHandle}. The card is in their direct messages and only they can answer it. ` +
        `If they approve, this conversation gains the tool \`${outcome.toolName}\` on its next turn. ` +
        `Tell the room the ask went out and carry on — nothing is granted yet, you will not be told here the moment they answer, ` +
        `and asking again for the same thing is refused.`,
      owner: outcome.ownerHandle,
    };
  },
});
preRegisterDynamicEntry("request_credential_grant", "_single", requestCredentialGrantEntry);

function jsonObjectProblem(value: unknown, path = "the fixed arguments", depth = 0): string | undefined {
  if (depth > 32) return `${path} nests too deeply`;
  if (value === null || typeof value === "string" || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : `${path} is ${String(value)}, which JSON cannot hold`;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const bad = jsonObjectProblem(item, `${path}[${String(i)}]`, depth + 1);
      if (bad !== undefined) return bad;
    }
    return undefined;
  }
  if (typeof value !== "object") return `${path} is a ${typeof value}, which JSON cannot hold`;
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return `${path} is not a plain JSON object`;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) return `${path}.${key} has no value`;
    const bad = jsonObjectProblem(v, `${path}.${key}`, depth + 1);
    if (bad !== undefined) return bad;
  }
  return undefined;
}

function replyTargetJson(ctx: BindableContext): string | undefined {
  try {
    const target = resolveReplyTarget(ctx);
    return target === null ? undefined : JSON.stringify(target);
  } catch {
    return undefined;
  }
}

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => (requestCredentialGrantMount(ctx as BindableContext) ? requestCredentialGrantEntry : null),
  },
});
