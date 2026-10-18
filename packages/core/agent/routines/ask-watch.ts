import type { SurfaceBinding } from "../identity/binding.js";
import { unattendedFrom } from "../identity/binding.js";
import { plainValue } from "../approvals/plain-text.js";
import { isProviderSelected } from "../access/provider-selection.js";
import { registeredEventSources } from "./event-model.js";
import { eventReach } from "./event-reach.js";
import { cronWords, sourceWords, type TriggerShape } from "./schedule-words.js";

export const WATCH_FOR_MAX_CHARS = 120;

export const DEFAULT_POLL_WORDS = "every hour";

const GENERIC_WEBHOOK_SCHEME = "oe-standard-webhook";

export async function watchableEventSources(): Promise<readonly string[]> {
  const candidates = registeredEventSources().filter((s) => s !== GENERIC_WEBHOOK_SCHEME && isProviderSelected(s));
  const reach = await Promise.all(candidates.map((s) => eventReach(s)));
  return candidates.filter((_, i) => reach[i] === "reaches");
}

export function appEventSourceWords(source: string): string {
  return `${sourceWords(source)} sends its own events here, with no declared webhook: a routine subscribes to them directly with create_routine (trigger kind "event", source "${source}") and a jq filter.`;
}

export async function appEventSourceNote(source: string): Promise<string | undefined> {
  try {
    const key = source.trim().toLowerCase();
    if (!(await watchableEventSources()).includes(key)) return undefined;
    return `"${key}" is not a declared webhook. ${appEventSourceWords(key)} Its deliveries are not captured for reading here, so write the filter from the event shape create_routine describes.`;
  } catch {
    return undefined;
  }
}

export function cleanWatchFor(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.replace(/\s+/gu, " ").trim().replace(/[.!]+$/u, "");
  if (text.length === 0) return undefined;
  if (text.length > WATCH_FOR_MAX_CHARS) {
    throw new Error(`\`watchFor\` is one short line of at most ${WATCH_FOR_MAX_CHARS} characters, the condition in the person's words ("a new issue is opened in acme/web"). Shorten it.`);
  }
  return text;
}

function pollWords(t: TriggerShape): string {
  if (t.expr !== undefined) return cronWords(t.expr);
  return t.everyMinutes === 60 ? "every hour" : `every ${t.everyMinutes ?? "?"} min`;
}

export function watchWords(t: TriggerShape, watchFor: string | undefined): string | undefined {
  if (watchFor === undefined) return undefined;
  const what = plainValue(watchFor, WATCH_FOR_MAX_CHARS);
  if (t.kind === "event") return `watches ${t.source !== undefined ? sourceWords(t.source) : "an app"} for when ${what}`;
  if (t.kind === "watch") return `checks ${pollWords(t)} for when ${what}`;
  return undefined;
}

export function askWatchBlock(sources: readonly string[]): string {
  const names = [...new Set(sources.map(sourceWords))];
  const eventLine =
    names.length > 0
      ? `- ${names.join(", ")} ${names.length === 1 ? "sends its" : "send their"} events here. For ${names.length === 1 ? "it" : "these"}, the job subscribes to the app's events (an event routine) with a filter for the condition.`
      : "- No app sends its events here yet.";
  return `### "Tell me when …"

When a person asks you to tell them when something happens in a connected app, set up a watch for it. Only
an ask sets up a watch. Never set one up because an app was connected, and never offer one for each app.

Say the watch back in ONE plain sentence: the app, what you watch for, and where you will tell them (here).
For example: "I'll watch GitHub and tell you here when a new issue is opened in acme/web." Use friendly names
and never an id. In the same turn, hand off the job that creates the routine, with the app, the condition and
your sentence in the brief. The routine card is the one confirmation: its approve button arms the watch.

How the job builds it:
${eventLine}
- For any other connected app, the job sets up a check ${DEFAULT_POLL_WORDS} (only-on-change), unless the person asked for
  another cadence. Its prompt checks the condition and records only whether it is met and what met it. It
  posts once on its first check, with what it sees now, and after that only when the answer changes. Say so
  in your sentence.
- In both cases the job sets \`watchFor\` to the condition in plain words.`;
}

export interface AskWatchTurn {
  readonly binding: SurfaceBinding;
  readonly worker: boolean;
}

export async function askWatchSeatBlock(turn: AskWatchTurn, sources?: readonly string[]): Promise<string> {
  try {
    if (turn.worker || unattendedFrom(turn.binding)) return "";
    if (turn.binding.mode !== "dm" && turn.binding.mode !== "channel") return "";
    return askWatchBlock(sources ?? (await watchableEventSources()));
  } catch {
    return "";
  }
}
