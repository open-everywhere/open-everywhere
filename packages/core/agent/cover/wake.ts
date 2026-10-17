import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { clipCoverText, coverLive, readPersonalCover, recordCoverAnswer, recordCoverQuestion } from "./state.js";

export const COVER_WAKE_TTL_MS = 6 * 60 * 60 * 1000;
export const COVER_MAX_MENTIONS = 5;

export const COVER_WAKE_ACTION = "cover.wake";
export const COVER_ANSWERED_ACTION = "cover.answered";

const POINTER_PREFIX = "cover-wake:";

export interface CoveredPerson {
  readonly principalKey: string;
  readonly id: string;
  readonly name?: string;
}

export interface CoverWakeInput {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly surfaceKey: string;
  readonly channelId: string;
  readonly roomPublic: boolean;
  readonly wakeId: string | undefined;
  readonly mentionedIds: readonly string[];
  readonly askerId?: string;
  readonly askerName?: string;
  readonly text: string;
  readonly now?: Date;
  readonly confirmInRoom?: (id: string) => Promise<boolean>;
}

export interface CoverWakeResult {
  readonly systemNote?: string;
  readonly covered: readonly CoveredPerson[];
}

export function renderCoverNote(ids: readonly string[]): string {
  const who = ids.length === 1 ? `person ${ids[0]}` : `people ${ids.join(", ")}`;
  const they = ids.length === 1 ? "they are" : "they are each";
  return [
    `Out-of-office cover: this message mentions ${who}, and ${they} away with cover on.`,
    "If the message asks them something, answer it for them in this room, from what this room and its domain already know.",
    "Do not promise, agree, decide or commit to anything on their behalf, and do not act as them.",
    "If you do not know, say so. Do not promise what they will see or do when they are back.",
    "The host starts EVERY reply on this wake with the cover label, so do not write a label of your own.",
    "If the message asks them nothing, you may stay silent: any reply you post here is labelled as cover for them.",
  ].join(" ");
}

export function labelName(name: string | undefined): string | undefined {
  const plain = (name ?? "").replace(/[<>&*_~`|\\[\]]/g, "").replace(/\s+/g, " ").trim();
  return plain.length > 0 ? plain.slice(0, 80) : undefined;
}

export function renderCoverLabel(people: readonly Pick<CoveredPerson, "name">[]): string {
  const names = people.map((p) => labelName(p.name)).filter((n): n is string => n !== undefined);
  if (names.length === 0) return people.length > 1 ? "Cover for the people you mentioned, who are away:" : "Cover for the person you mentioned, who is away:";
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
  return `Cover for ${list}, who ${names.length === 1 ? "is" : "are"} away:`;
}

export function withCoverLabel(body: string, label: string): string {
  return body.trimStart().startsWith(label) ? body : `${label}\n${body}`;
}

export async function coverForWake(input: CoverWakeInput): Promise<CoverWakeResult> {
  const none: CoverWakeResult = { covered: [] };
  if (!input.wakeId) return none;
  const now = input.now ?? new Date();
  const ids = [...new Set(input.mentionedIds)].filter((id) => id !== input.askerId).slice(0, COVER_MAX_MENTIONS);
  if (ids.length === 0) return none;
  const covered: CoveredPerson[] = [];
  for (const id of ids) {
    const principalKey = tryPrincipalKey(input.platform, input.workspace, id);
    if (!principalKey) continue;
    const read = await readPersonalCover(input.org, principalKey);
    if (!read.readable || !coverLive(read.state, now)) continue;
    covered.push({ principalKey, id, ...(read.state?.name ? { name: read.state.name } : {}) });
  }
  if (covered.length === 0) return none;
  const at = now.toISOString();
  try {
    await getOperationalStore().putTaskResult(input.org, `${POINTER_PREFIX}${input.wakeId}`, JSON.stringify({ covered }), at, COVER_WAKE_TTL_MS);
  } catch (err) {
    console.warn(`[open-everywhere:cover] the cover pointer for wake ${input.wakeId} did not write: ${String(err)} — no cover on this wake`);
    return none;
  }
  const question = clipCoverText(input.text);
  for (const person of covered) {
    let kept = false;
    const inRoom = !input.roomPublic && input.confirmInRoom ? await input.confirmInRoom(person.id).catch(() => false) : false;
    try {
      kept = await recordCoverQuestion(
        input.org,
        person.principalKey,
        {
          wakeId: input.wakeId,
          at,
          ...(input.askerName ? { askerName: input.askerName } : {}),
          platform: input.platform,
          channelId: input.channelId,
          surfaceKey: input.surfaceKey,
          roomPublic: input.roomPublic,
          ...(inRoom === true ? { inRoom: true as const } : {}),
          question,
        },
        now,
      );
    } catch (err) {
      console.warn(`[open-everywhere:cover] the question for ${person.principalKey} did not record: ${String(err)}`);
    }
    await appendAudit({
      org: input.org,
      platform: input.platform,
      workspace: input.workspace,
      surface: input.surface,
      principalId: person.principalKey,
      action: COVER_WAKE_ACTION,
      detail: { wakeId: input.wakeId, recorded: kept, mentioned: ids.length },
    }).catch(() => undefined);
  }
  return { systemNote: renderCoverNote(covered.map((p) => p.id)), covered };
}

export async function coveredOnWake(org: string | undefined, wakeId: string | undefined): Promise<readonly CoveredPerson[] | undefined> {
  if (!org || !wakeId) return undefined;
  try {
    const raw = await getOperationalStore().getTaskResult(org, `${POINTER_PREFIX}${wakeId}`);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { covered?: unknown };
    const covered = (Array.isArray(parsed.covered) ? parsed.covered : []).filter(
      (p): p is CoveredPerson => typeof (p as CoveredPerson)?.principalKey === "string" && typeof (p as CoveredPerson)?.id === "string",
    );
    return covered.length > 0 ? covered : undefined;
  } catch (err) {
    console.warn(`[open-everywhere:cover] the cover pointer for wake ${wakeId} did not read: ${String(err)}`);
    return undefined;
  }
}

export interface CoverReply {
  readonly label: string;
  readonly covered: readonly CoveredPerson[];
}

export async function coverLabelForReply(org: string | undefined, wakeId: string | undefined): Promise<CoverReply | undefined> {
  const covered = await coveredOnWake(org, wakeId);
  return covered ? { label: renderCoverLabel(covered), covered } : undefined;
}

export async function recordCoverReply(
  where: { readonly org: string; readonly platform: string; readonly workspace: string; readonly surface: string },
  wakeId: string,
  reply: CoverReply,
  answer: string,
): Promise<void> {
  for (const person of reply.covered) {
    let attached = false;
    try {
      attached = await recordCoverAnswer(where.org, person.principalKey, wakeId, answer);
    } catch (err) {
      console.warn(`[open-everywhere:cover] the answer for ${person.principalKey} did not record: ${String(err)}`);
    }
    if (!attached) continue;
    await appendAudit({
      org: where.org,
      platform: where.platform,
      workspace: where.workspace,
      surface: where.surface,
      principalId: person.principalKey,
      action: COVER_ANSWERED_ACTION,
      detail: { wakeId, chars: answer.length },
    }).catch(() => undefined);
  }
}
