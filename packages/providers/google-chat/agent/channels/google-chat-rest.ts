import { friendlyOutboundText, markNotApplied } from "@open-everywhere/core/agent/adapter-api.js";
import { googleChatAccessToken, type GoogleChatTokenDeps } from "./google-chat-auth.js";

const CHAT_API = "https://chat.googleapis.com/v1";
export const GOOGLE_CHAT_MAX_TEXT = 4000;

const SPACE_NAME = /^spaces\/[A-Za-z0-9_-]{1,128}$/u;
const THREAD_NAME = /^spaces\/[A-Za-z0-9_-]{1,128}\/threads\/[A-Za-z0-9_.-]{1,128}$/u;
const MESSAGE_NAME = /^spaces\/[A-Za-z0-9_-]{1,128}\/messages\/[A-Za-z0-9_.-]{1,128}$/u;

export function isSpaceName(v: unknown): v is string {
  return typeof v === "string" && SPACE_NAME.test(v);
}

export function isThreadNameIn(v: unknown, space: string): v is string {
  return typeof v === "string" && THREAD_NAME.test(v) && v.startsWith(`${space}/threads/`);
}

export function isMessageNameIn(v: unknown, space: string): v is string {
  return typeof v === "string" && MESSAGE_NAME.test(v) && v.startsWith(`${space}/messages/`);
}

export function splitGoogleChatText(text: string, max = GOOGLE_CHAT_MAX_TEXT): readonly string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const nl = rest.lastIndexOf("\n", max);
    let cut = nl > max / 2 ? nl : max;
    const before = rest.charCodeAt(cut - 1);
    if (before >= 0xd800 && before <= 0xdbff) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/u, "");
  }
  out.push(rest);
  return out;
}

export interface GoogleChatPostDeps extends GoogleChatTokenDeps {}

export async function createGoogleChatMessage(
  input: { readonly space: string; readonly thread?: string; readonly text: string },
  deps: GoogleChatPostDeps = {},
): Promise<string> {
  if (!isSpaceName(input.space)) throw markNotApplied(new Error("the Google Chat space name is not valid."));
  if (input.thread !== undefined && !isThreadNameIn(input.thread, input.space)) {
    throw markNotApplied(new Error("the Google Chat thread does not belong to the space."));
  }
  if (input.text.trim() === "") throw markNotApplied(new Error("a Google Chat message needs text."));
  const text = await friendlyOutboundText(input.text, "google-chat");
  const token = await googleChatAccessToken(deps);
  const doFetch = deps.fetch ?? fetch;
  let thread = input.thread;
  let last = "";
  for (const piece of splitGoogleChatText(text)) {
    const url = `${CHAT_API}/${input.space}/messages${thread !== undefined ? "?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" : ""}`;
    const res = await doFetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ text: piece, ...(thread !== undefined ? { thread: { name: thread } } : {}) }),
    });
    if (!res.ok) throw new Error(`Google Chat refused the message (HTTP ${res.status}).`);
    const body = (await res.json().catch(() => ({}))) as { name?: unknown; thread?: { name?: unknown } };
    if (typeof body.name !== "string") throw new Error("Google Chat returned no message name.");
    last = body.name;
    const created = body.thread?.name;
    if (thread === undefined && isThreadNameIn(created, input.space)) thread = created;
  }
  return last;
}
