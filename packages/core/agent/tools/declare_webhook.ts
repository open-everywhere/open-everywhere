import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { resolvePartition } from "../memory/partition.js";
import { principalIdOf, resolveMode } from "../access/request.js";
import { bindFrom } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { describeReadableBy, readableByDefects, type ReadableBy } from "../access/read-grant.js";
import { requestApproval, postedToSurfaceKey } from "../approvals/flow.js";
import { approvalPostDeps, hasApprovalCardPath } from "./set_spend_limit.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import { requireWebhookDeclareConfig } from "../approvals/webhook-declare.js";
import { runtimeHookSourceVocabulary, unknownSourceRefusal } from "../webhooks/source-vocabulary.js";
import { RUNTIME_HOOK_ID_PREFIX, WEBHOOK_POSTURES, type WebhookPosture } from "../webhooks/runtime-hook.js";
import { eventNormalizer } from "../routines/event-model.js";
import type { HookDeclaration } from "../webhooks/hooks-codemod.js";

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function secretRefForHookId(id: string): string {
  return `OE_WEBHOOK_${id.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_SECRET`;
}

export default defineTool({
  description:
    "Propose a config-declared inbound webhook: an endpoint that, when an outside system POSTs to it, runs ONE standing instruction in ONE channel. Use when someone wants an external system to drive a fixed, repeatable action here (\"when CI finishes, post the result in #deploys\"). This does NOT create anything — it opens a pull request adding the declaration to this deployment's config, for a human to review and merge; an operator then sets the signing secret separately, so no secret ever appears in the PR or in chat. Prefer create_webhook instead when the caller wants an ingress whose consequences will be decided later by routines rather than a fixed instruction. `readableBy` is required: name the memory domain(s) whose routines may subscribe to this hook's events. `posture` is required too: it decides how much of the sender's payload ever reaches the prompt — none of it, only named fields, or all of it.",
  inputSchema: z.object({
    id: z
      .string()
      .min(1)
      .describe('URL path segment — the hook will live at POST /webhooks/<id>. Short, lowercase, url-safe, e.g. "deploy-status". It is also the `source` an event routine subscribes to.'),
    source: z
      .string()
      .min(1)
      .describe(
        'WHICH SIGNATURE SCHEME its sender signs with. Use "oe-standard-webhook" for a sender you configure or can script (CI, a build box, an internal service) — that is a contract WE define and THEY implement. Name a vendor instead ("github") when the vendor signs in its own scheme. Unknown schemes are refused, naming the registered set.',
      ),
    target: z.string().min(1).describe('The fully-qualified "slack/TEAM/CHANNEL" surface the hook fires into.'),
    instruction: z.string().min(1).describe("What the agent should DO on every accepted delivery. It runs unattended, with that channel's full access, forever — write it as narrowly as the job allows."),
    posture: z
      .enum(WEBHOOK_POSTURES as unknown as [WebhookPosture, ...WebhookPosture[]])
      .describe(
        'How much of the payload reaches the prompt, on every delivery, forever. "trigger-only": none of it — the instruction runs on the FACT that the hook fired. "projection": only the fields named in `project`. "content-bearing": the entire raw body as untrusted data. Ask for the narrowest one that lets the instruction work; if the instruction only needs two fields, that is "projection", not "content-bearing".',
      ),
    project: z
      .array(z.string().min(1))
      .optional()
      .describe('With posture "projection" only: the field key names to render, e.g. ["status","branch"]. Required for that posture and refused for the others. Keys are checked against what this source\'s adapter can actually produce, and an unknown one is refused naming the available set.'),
    readableBy: z
      .array(z.string().min(1))
      .min(1)
      .describe('Memory domain NAME(s) whose routines may read this hook\'s events — required, no default. Use ["*"] ONLY to mean EVERY domain in the org, and say so out loud to the user first.'),
    reason: z.string().optional().describe("Why this is wanted, for the PR body and the admin note."),
  }),
  outputSchema: z.object({
    proposed: z.boolean(),
    pending: z.boolean(),
    pendingId: z.string().optional(),
    id: z.string(),
    readableBy: z.string(),
    message: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "declare_webhook");

    if (untrustedIngestedThisTurn()) {
      throw new Error(
        "I've read external content this turn, so I won't propose a webhook right now — declaring one hands an outside system a standing way to run an instruction in a channel, and that shouldn't be proposed off something I just read. Ask me again in a fresh message and I'll do it.",
      );
    }

    const mode = resolveMode(ctx);
    if (mode === "mpim") throw new Error("Group DMs are execution-only — propose webhooks from a channel or a DM instead.");

    const binding = bindFrom(ctx);
    if (!hasApprovalCardPath(binding.platform)) {
      throw new Error(
        `Proposing a webhook needs a surface with an approval-card path (Slack or Discord) — this is "${binding.platform}". A human has to read the exact declaration before a PR is opened in their name.`,
      );
    }
    const cfg = requireWebhookDeclareConfig();

    const id = input.id.trim().toLowerCase();
    if (!ID_RE.test(id)) throw new Error(`A hook id is a short lowercase url-safe token (letters, digits, "_" or "-"), got ${JSON.stringify(input.id)}.`);
    if (id.startsWith(RUNTIME_HOOK_ID_PREFIX)) {
      throw new Error(`"${RUNTIME_HOOK_ID_PREFIX}" is reserved for hooks minted host-side by create_webhook — pick a different id.`);
    }
    if (cfg.baseWebhooks!().some((h) => h.id === id)) {
      throw new Error(`A webhook "${id}" is already declared in this deployment's config. Point the sender at that one, or pick a different id — I can only add hooks, never redirect a live one.`);
    }

    const source = input.source.trim().toLowerCase();
    const vocabulary = runtimeHookSourceVocabulary();
    if (!vocabulary.includes(source)) throw new Error(unknownSourceRefusal(source, vocabulary));

    const parts = input.target.trim().split("/");
    if (parts.length !== 3 || parts[0] !== "slack" || !parts[1] || !parts[2]) {
      throw new Error(`The target must be a fully-qualified "slack/TEAM/CHANNEL" surface, got ${JSON.stringify(input.target)}. Config-hook targets are Slack-only today.`);
    }

    const wantsOrg = input.readableBy.some((d) => d.trim() === "*");
    if (wantsOrg && input.readableBy.length > 1) {
      throw new Error('`readableBy: ["*"]` already means EVERY domain in the org — listing it alongside named domains is contradictory. Send either "*" alone or the specific domains.');
    }
    const declaredDomains = new Set(getConfig().loadDomains().map((d) => d.name));
    const readableBy: ReadableBy = wantsOrg ? [{ level: "org" }] : input.readableBy.map((d) => ({ level: "domain", domain: d.trim() }));
    if (!wantsOrg) {
      const unknownDomains = input.readableBy.map((d) => d.trim()).filter((d) => !declaredDomains.has(d));
      if (unknownDomains.length > 0) {
        throw new Error(
          `This deployment has no memory domain called ${unknownDomains.map((d) => `"${d}"`).join(", ")} — a grant naming one would refuse every routine forever. ` +
            (declaredDomains.size > 0 ? `The declared domains are: ${[...declaredDomains].sort().join(", ")}.` : "No domains are declared at all, so an operator has to add one (in agent/memory/domains.ts, by PR) before any webhook can be readable by anything."),
        );
      }
    }
    const grantDefects = readableByDefects(readableBy);
    if (grantDefects.length > 0) throw new Error(`That read grant isn't usable: ${grantDefects.join("; ")}`);

    const project = input.project?.map((k) => k.trim()).filter((k) => k.length > 0) ?? [];
    if (input.posture === "projection" && project.length === 0) {
      throw new Error(
        'Posture "projection" needs `project` — the field names to put in the prompt. A projection with no fields renders nothing, which is what posture "trigger-only" is for.',
      );
    }
    if (input.posture !== "projection" && project.length > 0) {
      throw new Error(`\`project\` is only read under posture "projection" — with posture "${input.posture}" it narrows nothing, so I won't declare a hook that implies otherwise.`);
    }
    if (input.posture === "projection") {
      const normalizer = eventNormalizer(source);
      if (normalizer && !normalizer.matchKeysOpen) {
        const unknownKeys = project.filter((k) => !normalizer.matchKeys.includes(k));
        if (unknownKeys.length > 0) {
          throw new Error(
            `The "${source}" adapter can't produce ${unknownKeys.map((k) => `"${k}"`).join(", ")}, so a projection over ${unknownKeys.length > 1 ? "those fields" : "that field"} would put nothing in the prompt on every delivery. ` +
              `It produces: ${[...normalizer.matchKeys].sort().join(", ") || "no fields at all"}.`,
          );
        }
      }
    }

    const p = resolvePartition(ctx);
    const requestedBy = principalIdOf(ctx);
    if (!requestedBy) throw new Error("declare_webhook needs a verified sender — there's no requester to show on the approval card.");
    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) throw new Error("declare_webhook couldn't resolve this channel's id for the approval card — try again from a real channel.");

    const declaration: HookDeclaration = {
      id,
      source,
      secretRef: secretRefForHookId(id),
      broker: "env",
      target: input.target.trim(),
      readableBy,
      posture: input.posture,
      ...(project.length > 0 ? { project } : {}),
      instruction: input.instruction.trim(),
    };

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "webhook.declare",
        args: {
          org: p.org,
          scopeKey: p.surfaceKey,
          requestId: randomUUID(),
          declaration,
          requestedBy,
          ...(input.reason ? { reason: input.reason } : {}),
          channelId,
          threadTs: binding.threadTs ?? null,
          configRepo: cfg.configRepo,
        },
        scopeKey: p.surfaceKey,
        domain: null,
        requestedBy,
        channelId,
        threadTs: binding.threadTs ?? null,
        postedTo: postedToSurfaceKey(binding, channelId),
      },
      approvalPostDeps(binding.platform),
    );

    return {
      proposed: true,
      pending: true,
      pendingId: posted.id,
      id,
      readableBy: describeReadableBy(readableBy),
      message:
        `card posted — approving it opens a PR against ${cfg.configRepo} declaring webhook "${id}" (pending ${posted.id}). ` +
        `Its events will be readable by ${describeReadableBy(readableBy)}. ` +
        `Nothing exists until an admin merges the PR, and nothing can authenticate until an operator sets the secret in \`${declaration.secretRef}\` — I never see that value.`,
    };
  },
});
