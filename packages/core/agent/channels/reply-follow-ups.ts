import { z } from "zod";

export const FOLLOW_UP_MAX = 3;

export const FOLLOW_UP_TEXT_MAX = 75;

const INVISIBLE = /[\p{Cc}\p{Cf}]/u;

export const FOLLOW_UPS_INPUT = z
  .array(z.string())
  .optional()
  .describe(
    `Optional: up to ${FOLLOW_UP_MAX} short next steps the person might want after this answer, each one line of at most ${FOLLOW_UP_TEXT_MAX} characters, ` +
      "written as the person would say it (\"Draft the reply\", \"Show last week too\"). Each shows as a button under your answer; pressing one " +
      "sends that text to you as the person's next message. Offer them only when a next step is genuinely likely, never as filler. " +
      "They show only on a finished answer (`done` true) in a one-to-one conversation with the person, and are ignored anywhere else.",
  );

export function normalizeFollowUps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const text = item.replace(/\s+/gu, " ").trim();
    if (text.length === 0 || Array.from(text).length > FOLLOW_UP_TEXT_MAX) continue;
    if (INVISIBLE.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length === FOLLOW_UP_MAX) break;
  }
  return out;
}
