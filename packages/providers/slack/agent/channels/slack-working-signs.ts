import { STATUS_REACTION, swallowRoomOp, type ReactionState } from "@open-everywhere/core/agent/adapter-api.js";

export type SlackSignRequest = (method: string, params: Readonly<Record<string, string>>) => Promise<void>;

export async function setSlackStatusReaction(request: SlackSignRequest, target: { readonly channel: string; readonly timestamp: string }, state: ReactionState | "none"): Promise<void> {
  if (swallowRoomOp("a slack status reaction")) return;
  await Promise.all(
    Object.entries(STATUS_REACTION).map(([s, name]) => request(s === state ? "reactions.add" : "reactions.remove", { channel: target.channel, name, timestamp: target.timestamp })),
  );
}

export const SLACK_STATUS_LINE_METHOD = "assistant.threads.setStatus";

export function isSlackStatusLineRequest(input: Parameters<typeof fetch>[0]): boolean {
  try {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(href).pathname.endsWith(`/${SLACK_STATUS_LINE_METHOD}`);
  } catch {
    return false;
  }
}

export function slackFetchWithoutStatusLine(): typeof fetch {
  return (input, init) =>
    isSlackStatusLineRequest(input)
      ? Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }))
      : globalThis.fetch(input, init);
}
