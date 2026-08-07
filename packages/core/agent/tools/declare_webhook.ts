import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { resolvePartition } from "../memory/partition.js";
import { actingPrincipalIdOf, resolveMode } from "../access/request.js";
import { bindFrom } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { describeReadableBy, readableByDefects, type ReadableBy } from "../access/read-grant.js";
import { requestApproval, postedToSurfaceKey, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps, hasApprovalCardPath } from "./set_spend_limit.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import { requireWebhookDeclareConfig } from "../approvals/webhook-declare.js";
import {
  declarableSourceVocabulary,
  generalPurposeSchemes,
  mintableSourceVocabulary,
  unknownSourceRefusal,
  unmintableSourceRefusal,
  type SourceVocabularyDeps,
} from "../webhooks/source-vocabulary.js";
import { WEBHOOK_POSTURES, type WebhookPosture } from "../webhooks/config.js";
import { eventNormalizer } from "../routines/event-model.js";
import type { HookDeclaration } from "../webhooks/hooks-codemod.js";

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function secretRefForHookId(id: string): string {
  return `OE_WEBHOOK_${id.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_SECRET`;
}

export function dbSecretRefForHookId(id: string): string {
  return `db:webhook:${id}`;
}

export function generalPurposeSchemeHint(source: string, contracts: readonly string[]): string {
  const alternatives = contracts.filter((s) => s !== source);
  if (alternatives.length === 0) return "";
  return (
    `\n\nBefore asking for that PR: if "${source}" is something you control or can script (a CI job, a build, an internal service), it does NOT need an adapter of its own. ` +
    `Put "${source}" in the hook's \`id\` instead — the id is the handle, and it is what an \`event\` routine subscribes to — and set \`source\` to a general-purpose contract ` +
    `this deployment already has (${alternatives.join(", ")}). The sender then implements our signing contract instead of us implementing theirs.`
  );
}

export function sourceVocabularyRefusal(source: string, secretHome: "env" | "db", envRef: string, deps: SourceVocabularyDeps = {}): string | undefined {
  const declarable = declarableSourceVocabulary(deps);
  if (!declarable.includes(source)) return unknownSourceRefusal(source, declarable) + generalPurposeSchemeHint(source, generalPurposeSchemes(deps));
  if (secretHome === "db" && !mintableSourceVocabulary(deps).includes(source)) return unmintableSourceRefusal(source, envRef);
  return undefined;
}

export default defineTool({
  description:
    "Propose an inbound webhook: an endpoint an outside system can POST to. It comes in two shapes and you pick by whether you pass `target` + `instruction` together. WITH them, every accepted delivery runs that ONE standing instruction in that ONE channel — right when the consequence is a single fixed thing (\"when CI finishes, post the result in #deploys\"). WITHOUT them the hook is EMIT-ONLY: it just becomes a door, and what happens is decided afterwards by `event` routines someone creates separately — right when the consequences aren't settled yet, are likely to change, or are several different reactions to one system. Pass both fields or neither; one alone is refused. This does NOT create anything — it opens a pull request adding the declaration to this deployment's config, for a human to review and merge; an operator then sets the signing secret separately, so no secret ever appears in the PR or in chat. `readableBy` is required: name the memory domain(s) whose routines may subscribe to this hook's events. `posture` is required too: it decides how much of the sender's payload ever reaches the prompt — none of it, only named fields, or all of it.",
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
    target: z
      .string()
      .min(1)
      .optional()
      .describe('The fully-qualified "slack/TEAM/CHANNEL" surface the hook fires into. Omit it (together with `instruction`) for an emit-only hook that fires nothing by itself.'),
    instruction: z
      .string()
      .min(1)
      .optional()
      .describe(
        "What the agent should DO on every accepted delivery. It runs unattended, with that channel's full access, forever — write it as narrowly as the job allows. Omit it (together with `target`) for an emit-only hook.",
      ),
    secretHome: z
      .enum(["env", "db"])
      .optional()
      .describe(
        'Where the signing secret will live. "env" (the default) means an operator sets an environment variable and redeploys — right when they already hold the secret, e.g. a vendor gave it to them. "db" means the secret is stored here instead: after the PR merges, someone asks to rotate this webhook and gets a one-time link with a freshly generated secret to paste into the sender — no redeploy. Ask for "db" when the sender is something the org configures itself (CI, a script, an internal service). Most vendors GENERATE the signing secret themselves rather than letting us choose it; for those "db" is refused (a secret we made up would never verify) and "env" is the only answer.',
      ),
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
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
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
    const requestedBy = actingPrincipalIdOf(ctx);
    if (!requestedBy) {
      throw new Error("declare_webhook needs a verified sender — a triggered routine fire has no acting sender (only the creator it is attributed to), and a fire may not open a config PR declaring a standing inbound door in that person's name. Ask a person in this conversation to propose it.");
    }
    const cfg = requireWebhookDeclareConfig();

    const id = input.id.trim().toLowerCase();
    if (!ID_RE.test(id)) throw new Error(`A hook id is a short lowercase url-safe token (letters, digits, "_" or "-"), got ${JSON.stringify(input.id)}.`);
    if (cfg.baseWebhooks!().some((h) => h.id === id)) {
      throw new Error(`A webhook "${id}" is already declared in this deployment's config. Point the sender at that one, or pick a different id — I can only add hooks, never redirect a live one.`);
    }

    const source = input.source.trim().toLowerCase();
    const secretHome = input.secretHome ?? "env";

    const refusal = sourceVocabularyRefusal(source, secretHome, secretRefForHookId(id));
    if (refusal !== undefined) throw new Error(refusal);

    const target = input.target?.trim() || undefined;
    const instruction = input.instruction?.trim() || undefined;
    if ((target === undefined) !== (instruction === undefined)) {
      throw new Error(
        target !== undefined
          ? "A target with no instruction would fire that channel with nothing to say. Either tell me what it should do there, or drop the target and I'll declare an emit-only hook — a door whose consequences you decide later with `event` routines."
          : "An instruction with no target has nowhere to run. Either name the \"slack/TEAM/CHANNEL\" surface it should run in, or drop the instruction and I'll declare an emit-only hook — a door whose consequences you decide later with `event` routines.",
      );
    }
    if (target !== undefined) {
      const parts = target.split("/");
      if (parts.length !== 3 || parts[0] !== "slack" || !parts[1] || !parts[2]) {
        throw new Error(`The target must be a fully-qualified "slack/TEAM/CHANNEL" surface, got ${JSON.stringify(input.target)}. Config-hook targets are Slack-only today.`);
      }
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
    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) throw new Error("declare_webhook couldn't resolve this channel's id for the approval card — try again from a real channel.");

    const declaration: HookDeclaration = {
      id,
      source,
      secretRef: secretHome === "db" ? dbSecretRefForHookId(id) : secretRefForHookId(id),
      broker: secretHome,
      ...(target !== undefined ? { target } : {}),
      readableBy,
      posture: input.posture,
      ...(project.length > 0 ? { project } : {}),
      ...(instruction !== undefined ? { instruction } : {}),
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

    const tail =
      `Its events will be readable by ${describeReadableBy(readableBy)}. ` +
      (target === undefined ? "It fires nothing by itself — create an `event` routine subscribed to it to decide what happens. " : "") +
      `Nothing exists until an admin merges the PR, and nothing can authenticate until the secret is set` +
      (secretHome === "db"
        ? ` — after the merge, ask me to rotate the "${id}" webhook and you'll get a one-time link with a freshly generated secret to paste into the sender. No redeploy, and I never see the value.`
        : ` in \`${declaration.secretRef}\` — I never see that value.`);
    if (posted.autoApproved) {
      return {
        proposed: true,
        pending: false,
        autoApproved: true,
        pendingId: posted.id,
        id,
        readableBy: describeReadableBy(readableBy),
        message: `${autoApprovedNote(`PR against ${cfg.configRepo} declaring ${target === undefined ? "an emit-only " : ""}webhook "${id}"`, posted.autoApproved)} ${tail}`,
      };
    }
    return {
      proposed: true,
      pending: true,
      pendingId: posted.id,
      id,
      readableBy: describeReadableBy(readableBy),
      message:
        `card posted — approving it opens a PR against ${cfg.configRepo} declaring ${target === undefined ? "an emit-only " : ""}webhook "${id}" (pending ${posted.id}). ` +
        tail,
    };
  },
});
