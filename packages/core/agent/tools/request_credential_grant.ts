import { defineTool } from "eve/tools";
import { z } from "zod";
import { getConfig } from "../access/config.js";
import { credentialGrantRefusalNote, resolveGrantOwner } from "../access/credential-grant-ask.js";
import type { GrantAskWorkerOrigin } from "../access/credential-grant-card.js";
import { askForCredentialGrant, auditGrant, type GrantAuditStamps } from "../access/credential-grant-flow.js";
import { resolveRequesterLabel } from "../access/credential-grant-notice.js";
import { credentialGrantConnectors, domainsAdmitCredentialGrant } from "../access/credential-grant.js";
import { grantDomainScopeKey } from "../access/credential-grant-scope.js";
import { requesterThisTurn } from "../access/requester-identity.js";
import { sessionMountedTool } from "../access/window-gated.js";
import { adoptedOwnAccountAsk } from "../connections/own-account-carriage.js";
import { ownAccountVendorFor } from "../connections/own-account-vendors.js";
import { resolveReplyTarget } from "../channels/reply-post.js";
import { friendlyScopeLabel } from "../approvals/scope-label.js";
import { grantActionPhrase } from "../access/credential-grant-copy.js";
import { configuredAgentName } from "../identity/bot-name.js";
import { currentSessionId, currentTurnId, delegatedBindingUnresolved, delegationRootSessionId, isSubagentChildContext, windowGrainOf, type BindableContext } from "../identity/binding.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { resolvePartition } from "../memory/partition.js";
import type { Domain } from "../memory/domain.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";

const GRANT_DEFAULT_TOOLS: Readonly<Record<string, string>> = {
  notion: "notion-fetch",
};

export function defaultGrantTool(connector: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(GRANT_DEFAULT_TOOLS, connector) ? GRANT_DEFAULT_TOOLS[connector] : undefined;
}

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
    if (!mayRaiseGrantAsk(ctx)) {
      noteMountRefused(ctx, "grain");
      return false;
    }
  } catch {
    noteMountRefused(ctx, "grain");
    return false;
  }
  const domains = domainsForCtx(ctx);
  if (domains.length === 0) {
    const unresolved = delegatedBindingUnresolved(ctx);
    if (unresolved !== undefined) noteMountRefused(ctx, "binding-unresolved", { slot: unresolved });
    else noteMountRefused(ctx, "no-domain");
    return false;
  }
  for (const connector of credentialGrantConnectors()) if (domainsAdmitCredentialGrant(domains, connector)) return true;
  noteMountRefused(ctx, "no-declaration");
  return false;
}

type GrantMountRefusal = "grain" | "binding-unresolved" | "no-domain" | "no-declaration";

const auditedMountRefusals = new Set<string>();

export function _resetGrantMountAuditForTest(): void {
  auditedMountRefusals.clear();
}

let lastMountAudit: Promise<void> = Promise.resolve();

export function _grantMountAuditSettled(): Promise<void> {
  return lastMountAudit;
}

function noteMountRefused(ctx: BindableContext, reason: GrantMountRefusal, extra: AuditDetail = {}): void {
  try {
    const p = safePartitionOf(ctx);
    if (p === undefined) return;
    const sessionId = ctx.session?.id ?? p.surfaceKey;
    const key = `${sessionId}|${reason}`;
    if (auditedMountRefusals.has(key)) return;
    auditedMountRefusals.add(key);
    let grain = "unknown";
    try {
      grain = windowGrainOf(ctx);
    } catch {
    }
    lastMountAudit = auditGrant(stampsOf(p), "grant.mount_refused", undefined, { grain, reason, surfaceKey: p.surfaceKey, ...extra }).catch(() => {
    });
  } catch {
  }
}

function safePartitionOf(ctx: BindableContext): ReturnType<typeof resolvePartition> | undefined {
  try {
    return resolvePartition(ctx);
  } catch {
    return undefined;
  }
}

function stampsOf(p: ReturnType<typeof resolvePartition>): GrantAuditStamps {
  return { org: p.org, platform: p.platform, workspace: p.workspace, ...(p.surface === undefined ? {} : { surface: p.surface }) };
}

async function auditVerbRefusal(ctx: BindableContext, gate: string, detail: AuditDetail, principalId?: string): Promise<void> {
  const p = safePartitionOf(ctx);
  if (p === undefined) return;
  try {
    await auditGrant(stampsOf(p), "grant.refused", principalId, { gate, ...detail });
  } catch {
  }
}

export function mayRaiseGrantAsk(ctx: BindableContext): boolean {
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
    "do not ask twice. When they approve, the grant lands on this conversation. The conversation " +
    "reaches the tool through the next task it hands work to, and the answer is posted here. This " +
    "grants nothing by itself. " +
    "🔴 ONE THING NEEDS THIS ASK: a PERSON'S OWN ACCOUNT, and only when a person here asked for it to be lent. " +
    "A connector NOBODY HAS BOUND HERE is a reason to SUGGEST this road, never to raise the ask yourself — name " +
    "what the org's own road cannot reach, say they can lend their own access, once, and stop. " +
    "Org work runs on the ORG'S OWN ROAD — the Notion REST skill on the team integration " +
    "key, or a connector already bound to this conversation — and you reach either by delegating the work to a " +
    "task, which is where those tools live. Never ask a person to lend their own access for work the org's own " +
    "road already does. " +
    "There is no TOOL NAME to look up first. A connector call that fails with " +
    '"not granted to this surface" is a reason to SUGGEST this road too, on the same terms; it is not this ask being refused, and it never becomes one. Say an ask ' +
    "went out, or was refused, only from what THIS tool hands back.",
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
      .optional()
      .describe(
        "OPTIONAL, and normally OMIT IT. The vendor's own tool name, spelled exactly as their " +
          "connection publishes it (for example `notion-fetch`). Name one only if you have already " +
          "seen it. 🔴 Do NOT go looking for it first: this conversation is not granted the " +
          "connector — that is why you are asking — so listing its tools is refused by design, and " +
          "that refusal is about the LISTING, never about this ask. Omitted, the ask names the " +
          "connector's default tool, which the owner sees on their card and can decline.",
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
    const known = credentialGrantConnectors();
    if (!known.includes(input.connector)) {
      return {
        asked: false,
        message:
          `Refused: "${input.connector}" is not a connector this deployment lends credentials for. ` +
          (known.length > 0 ? `It admits: ${known.join(", ")}.` : "It admits none, so nothing can be granted here."),
      };
    }
    const mcpTool = input.tool?.trim() || defaultGrantTool(input.connector);
    if (mcpTool === undefined) {
      await auditVerbRefusal(c, "no_default_tool", { connector: input.connector });
      return {
        asked: false,
        message:
          `Refused: this deployment has no default tool for "${input.connector}", so an ask must name ` +
          "the vendor's own tool name in `tool`.",
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
          "Refused: only a task delegated from a conversation may raise this ask, and this session is not one. " +
          "Hand the work to a task; it asks on the conversation's behalf, and the grant binds to the conversation rather than to the task.",
      };
    }
    const p = resolvePartition(c);
    const domains = domainsForCtx(c);
    const scopeKey = grantScopeKey(c);
    const domainScopeKey = grantDomainScopeKey(c);
    if (scopeKey.length === 0) {
      await auditVerbRefusal(c, "no_scope_key", { connector: input.connector });
      return { asked: false, message: "Refused: this conversation has no session id, so there is no chat for a grant to be scoped to." };
    }
    const rootSessionId = delegationRootSessionId(c);
    const workerOrigin: GrantAskWorkerOrigin | undefined =
      rootSessionId === undefined ? undefined : { seatLabel: configuredAgentName() ?? UNNAMED_SEAT_LABEL };
    const verdict = requesterThisTurn(currentTurnId(c));
    const requesterPrincipalId = verdict.kind === "requester" ? tryPrincipalKey(p.platform, p.workspace, verdict.principalId) : undefined;

    const owner = await resolveGrantOwner(input.owner, p.platform, p.workspace);
    if ("refusal" in owner) {
      await auditVerbRefusal(
        c,
        "owner_unresolved",
        { connector: input.connector, scopeKey, ...(domainScopeKey === undefined ? {} : { domainScopeKey }) },
        requesterPrincipalId,
      );
      return { asked: false, message: owner.refusal };
    }

    const requesterLabel = requesterPrincipalId === undefined ? "an unverified caller" : ((await resolveRequesterLabel(requesterPrincipalId).catch(() => undefined)) ?? "");
    const requesterTarget = replyTargetJson(c);
    const conversationLabel = await grantConversationLabel(p.platform, p.workspace, p.surface);
    const audience = requesterPrincipalId !== undefined && requesterPrincipalId === owner.principalId ? "owner" : "seat";

    const explicit = adoptedOwnAccountAsk(c, [ownAccountVendorFor(input.connector)]) !== undefined;

    const outcome = await askForCredentialGrant({
      connector: input.connector,
      domainGrantsConnector: domainsAdmitCredentialGrant(domains, input.connector),
      explicit,
      frozenArgs: frozenArgs,
      mcpTool,
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
      ...(conversationLabel === undefined ? {} : { conversationLabel }),
      scopeKey,
      ...(domainScopeKey === undefined ? {} : { domainScopeKey }),
      ...(p.surface === undefined ? {} : { surface: p.surface }),
      targetLabel: input.target_label,
      ...(workerOrigin === undefined ? {} : { workerOrigin }),
      workspace: p.workspace,
    });

    if (!outcome.sent) {
      return {
        asked: false,
        message: credentialGrantRefusalNote(input.connector, outcome.reason, {
          audience,
          conversationLabel,
          expiresAt: outcome.liveGrant?.expiresAt,
          mcpTool: outcome.liveGrant?.mcpTool,
          nowMs: Date.now(),
          ownerLabel: owner.displayName,
        }),
      };
    }
    const who = owner.displayName ?? "them";
    return {
      askId: outcome.askId,
      asked: true,
      message:
        `Asked ${who}. The card is in their direct messages and only they can answer it. ` +
        `If they approve, this conversation reaches a tool that can ${grantActionPhrase(input.connector, mcpTool)} through the next task it hands work to. ` +
        `Tell the room the ask went out and carry on — nothing is granted yet, you will not be told here the moment they answer, ` +
        `and asking again for the same thing is refused.`,
      owner: who,
    };
  },
});

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

async function grantConversationLabel(platform: string, workspace: string, surface: string | undefined): Promise<string | undefined> {
  if (surface === undefined || surface.length === 0 || platform.length === 0 || workspace.length === 0) return undefined;
  return await friendlyScopeLabel(`${platform}/${workspace}/${surface}`);
}

function replyTargetJson(ctx: BindableContext): string | undefined {
  try {
    const target = resolveReplyTarget(ctx);
    return target === null ? undefined : JSON.stringify(target);
  } catch {
    return undefined;
  }
}

export default sessionMountedTool("request_credential_grant", requestCredentialGrantEntry, (ctx) => requestCredentialGrantMount(ctx));
