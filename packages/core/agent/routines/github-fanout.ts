import type { RouteHandlerArgs } from "eve/channels";
import slack from "../channels/slack.js";
import { listAllRoutines } from "./store.js";
import { matchesEvent, normalizeGithubEvent, eventPrompt, type NormalizedEvent } from "./events.js";
import { ROUTINE_MARKER } from "./routine.js";

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

async function fanOut(ev: NormalizedEvent, receive: RouteHandlerArgs["receive"]): Promise<void> {
  const matches = (await listAllRoutines()).filter((r) => r.status === "active" && matchesEvent(r, ev));
  let fired = 0;
  for (const r of matches) {
    const platform = r.surfaceKey.split("/")[0];
    const channelId = r.target?.["channelId"];
    if (platform !== "slack" || typeof channelId !== "string") {
      log(`event ${ev.summary} matched ${r.id} but its surface has no wired channel — skipped`);
      continue;
    }
    const auth = {
      authenticator: "github",
      principalType: "service",
      principalId: "github:webhook",
      attributes: { [ROUTINE_MARKER.id]: r.id, [ROUTINE_MARKER.surface]: r.surfaceKey, [ROUTINE_MARKER.org]: r.org },
    };
    await receive(slack, { message: eventPrompt(r, ev), target: { channelId }, auth });
    fired++;
  }
  if (matches.length > 0) log(`event "${ev.summary}": ${matches.length} matched -> ${fired} fired`);
}

export async function fanOutGitHubDelivery(body: string, eventType: string, receive: RouteHandlerArgs["receive"]): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return;
  }
  const ev = normalizeGithubEvent(eventType, payload);
  if (ev) await fanOut(ev, receive);
}
