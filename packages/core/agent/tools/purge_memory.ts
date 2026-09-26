import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolvePartition, type Partition } from "../memory/partition.js";
import { proposalScopeKey } from "../channels/propose-scope.js";
import { bindFrom, type SurfaceBinding } from "../identity/binding.js";
import { planFor, type ResolvedMemory } from "../memory/resolve.js";
import { principalIdOf, unattendedOf } from "../access/request.js";
import { resolveSkillDomain } from "../skills/domain-skills.js";
import { readTierFromSandbox } from "../memory/sandbox-sync.js";
import { bulletSha256 } from "../memory/purge-redaction.js";
import { tierId } from "../memory/store.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, cardPostedTail } from "../approvals/card-venue.js";
import { getConfig } from "../access/config.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";

export interface PurgeInput {
  readonly match: string;
}

export interface PurgeLocation {
  readonly siloName: string;
  readonly provider: string;
  readonly tierId: string;
  readonly file: string;
}

export interface PurgeCandidate {
  readonly bullet: string;
  readonly at: readonly PurgeLocation[];
}

export interface PurgeSearchTier {
  readonly siloName: string;
  readonly provider: string;
  readonly tierId: string;
  readonly files: Readonly<Record<string, string | undefined>>;
}

export const MAX_PURGE_BULLETS = 25;

export type PurgeMatchResult =
  | { readonly kind: "none" }
  | { readonly kind: "some"; readonly candidates: readonly PurgeCandidate[] }
  | { readonly kind: "toomany"; readonly count: number; readonly sample: readonly PurgeCandidate[] };

export function findPurgeCandidates(tiers: readonly PurgeSearchTier[], match: string): PurgeMatchResult {
  const needle = match.trim().toLowerCase();
  const byBullet = new Map<string, PurgeLocation[]>();

  for (const tier of tiers) {
    for (const [file, content] of Object.entries(tier.files)) {
      if (!content) continue;
      for (const rawLine of content.split("\n")) {
        if (!/^\s*-\s+/.test(rawLine)) continue;
        const line = rawLine.trim();
        if (!line.toLowerCase().includes(needle)) continue;
        const at = byBullet.get(line) ?? [];
        if (!at.some((l) => l.tierId === tier.tierId && l.file === file)) {
          at.push({ siloName: tier.siloName, provider: tier.provider, tierId: tier.tierId, file });
        }
        byBullet.set(line, at);
      }
    }
  }

  const candidates: PurgeCandidate[] = [...byBullet.entries()].map(([bullet, at]) => ({ bullet, at }));
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length > MAX_PURGE_BULLETS) return { kind: "toomany", count: candidates.length, sample: candidates.slice(0, 5) };
  return { kind: "some", candidates };
}

export interface PurgeArgs {
  readonly org: string;
  readonly partition: Partition;
  readonly bullets: readonly { readonly sha256: string; readonly chars: number }[];
  readonly locations: readonly PurgeLocation[];
}

export interface PurgePlan {
  readonly kind: "memory.purge";
  readonly args: PurgeArgs;
  readonly scopeKey: string;
  readonly domain: string | null;
  readonly cardLines: readonly string[];
}

const ERASING_MEMORY_PROVIDERS: ReadonlySet<string> = new Set(["sqlite", "postgres"]);

const APPEND_ONLY_MEMORY_PROVIDERS: ReadonlySet<string> = new Set(["notion"]);

function purgeErasureLines(locations: readonly PurgeLocation[]): readonly string[] {
  const silosWhere = (pred: (provider: string) => boolean): string[] =>
    [...new Set(locations.filter((l) => pred(l.provider)).map((l) => l.siloName))];
  const list = (silos: readonly string[]): string => silos.map((s) => `\`${s}\``).join(", ");

  const failing = silosWhere((p) => APPEND_ONLY_MEMORY_PROVIDERS.has(p));
  const retaining = silosWhere((p) => !APPEND_ONLY_MEMORY_PROVIDERS.has(p) && !ERASING_MEMORY_PROVIDERS.has(p));
  const lines: string[] = [];

  if (failing.length === 0 && retaining.length === 0) return ["This ERASES the line(s) from every silo listed. It cannot be undone."];

  lines.push("This removes the line(s) from the agent's memory, and it cannot be undone — except where this card says otherwise.");
  if (retaining.length > 0) {
    const many = retaining.length !== 1;
    lines.push(`NOT a full erasure in silo${many ? "s" : ""} ${list(retaining)}: the backing keeps the pre-purge text in its own history. Only a sqlite- or postgres-backed silo removes the bytes for good.`);
  }
  if (failing.length > 0) {
    const many = failing.length !== 1;
    lines.push(`🔴 NOTHING is removed from silo${many ? "s" : ""} ${list(failing)}: that backing is append-only (Notion), so the erasure FAILS there and the line STAYS. Remove it in Notion itself.`);
  }
  return lines;
}

export function planPurge(
  binding: SurfaceBinding,
  partition: Partition,
  tiers: readonly PurgeSearchTier[],
  input: PurgeInput,
  domain: string | null,
): PurgePlan {
  // principal-gate: accountability — the card's "asked by" line. The control on an erasure is the
  if (!binding.principalId) {
    throw new Error("purge_memory needs a verified sender on this turn — no principal id resolved, so there's no requester to show on the approval card.");
  }
  const match = input.match.trim();
  if (!match) {
    throw new Error("purge_memory needs a non-empty phrase to match against — quote a distinctive bit of the fact.");
  }

  const result = findPurgeCandidates(tiers, match);
  if (result.kind === "none") {
    throw new Error(
      `Nothing in this session's writable memory matches "${match}" — try quoting the fact more exactly (a longer, more distinctive phrase). ` +
        `Note that purge only erases; to CORRECT or reword a fact, just edit the memory file directly.`,
    );
  }
  if (result.kind === "toomany") {
    const list = result.sample.map((c) => `  • ${c.bullet}`).join("\n");
    throw new Error(
      `"${match}" matches ${result.count} remembered facts — too broad to erase in one act (max ${MAX_PURGE_BULLETS}). ` +
        `Quote a narrower phrase. First few:\n${list}`,
    );
  }

  const candidates = result.candidates;
  const bullets = candidates.map((c) => ({ sha256: bulletSha256(c.bullet), chars: c.bullet.length }));
  const locations: PurgeLocation[] = [];
  for (const c of candidates) {
    for (const l of c.at) {
      if (!locations.some((x) => x.tierId === l.tierId && x.file === l.file)) locations.push(l);
    }
  }

  const silos = [...new Set(locations.map((l) => l.siloName))];
  return {
    kind: "memory.purge",
    args: { org: binding.org, partition, bullets, locations },
    scopeKey: partition.surfaceKey,
    domain,
    cardLines: [
      `PURGE ${candidates.length === 1 ? "a remembered fact" : `${candidates.length} remembered facts`} — silo${silos.length === 1 ? "" : "s"} ${silos.map((s) => `\`${s}\``).join(", ")}`,
      ...candidates.map((c) => `> ${c.bullet}`),
      `Found in ${locations.length} file(s): ${locations.map((l) => `${l.tierId}/${l.file}`).join(", ")}`,
      ...purgeErasureLines(locations),
    ],
  };
}

const purgeEntry = defineTool({
  description:
    'PROPOSE ERASING remembered fact(s) from durable memory — this does NOT delete anything by itself, and it is the RARE, destructive path. Use it ONLY when somebody asks for information to be genuinely removed/erased (a mistake that must not persist, personal data, a retention request). To CORRECT, reword or supersede a fact, do NOT use this — just edit the memory file in /workspace/memory/ directly and the change persists at the end of the session. Give a distinctive phrase from the fact; every matching bullet across every writable memory silo is swept, and a confirmation card is posted showing the exact lines and where they live. Any member of this channel can click Confirm — nothing is erased until then. If the phrase matches nothing, or matches too many facts, this errors instead of guessing. The posted card IS the reply to the user — do not add any narration, summary, or confirmation text after this call. EXCEPT when this surface can\'t host a card: the card then goes to a card-capable channel in the same domain, the `note` field names it, and you MUST relay that, or the confirmation is somewhere the user can\'t see.',
  inputSchema: z.object({
    match: z.string().min(3).describe("A distinctive phrase from the fact(s) to erase — quote enough of it to identify the specific remembered lines, not just a topic word."),
  }),
  outputSchema: z.object({
    requested: z.boolean(),
    pendingId: z.string().optional(),
    expiresAt: z.string().optional(),
    note: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
  }),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "purge_memory");
    const binding = bindFrom(ctx);
    const partition = resolvePartition(ctx);
    const domain = resolveSkillDomain(ctx) ?? null;

    const plan = planFor(binding, partition);
    const writable: readonly ResolvedMemory[] = plan.writes;
    if (writable.length === 0) {
      throw new Error(
        `There's no writable memory to purge from here — ${plan.reason}. ` +
          `Put this channel in a domain (memory config) to give it a shared brain, or use a DM for private memory.`,
      );
    }

    const sandbox = await ctx.getSandbox();
    const tiers: PurgeSearchTier[] = [];
    for (const rm of writable) {
      tiers.push({
        siloName: rm.silo.name,
        provider: rm.silo.provider,
        tierId: tierId(rm.tier),
        files: await readTierFromSandbox(sandbox, rm.tier),
      });
    }

    const purgePlan = planPurge(binding, partition, tiers, input, domain);

    const venueResult = await checkApprovalVenue(binding, partition, () => getConfig().loadDomains());
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "purge that from memory"));
    }
    const venue = venueResult.venue;

    const posted = await requestApproval(
      {
        org: purgePlan.args.org,
        kind: purgePlan.kind,
        args: purgePlan.args,
        scopeKey: await proposalScopeKey(ctx, { org: purgePlan.args.org, surfaceKey: purgePlan.scopeKey }),
        domain: purgePlan.domain,
        requestedBy: principalIdOf(ctx)!,
        channelId: venue.channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
        chain: { unattended: unattendedOf(ctx) },
        summaryLines: purgePlan.cardLines,
      },
      approvalPostDeps(venue.platform, ctx),
    );

    const first = purgePlan.args.bullets[0]!;
    const more = purgePlan.args.bullets.length > 1 ? ` +${purgePlan.args.bullets.length - 1} more` : "";
    const subject = `purge ${first.sha256.slice(0, 12)}…${more}`;
    if (posted.autoApproved) {
      return {
        requested: false,
        autoApproved: true,
        pendingId: posted.id,
        note: autoApprovedNote(subject, posted.autoApproved),
      };
    }
    return {
      requested: true,
      pendingId: posted.id,
      expiresAt: posted.expiresAt,
      note: `${cardPostedPrefix(venue)} — ${subject} (pending ${posted.id}).` + cardPostedTail(venue, "confirm it", posted),
    };
  },
});
preRegisterDynamicEntry("purge_memory", "_single", purgeEntry);

export default defineDynamic({
  events: {
    "session.started": () => purgeEntry,
  },
});
