import { defineChannel, POST, type RouteHandlerArgs } from "eve/channels";
import slack from "./slack.js";
import { listAllRoutines } from "../routines/store.js";
import { matchesEvent, normalizeGithubEvent, eventPrompt, verifyGithubSignature, type NormalizedEvent } from "../routines/events.js";
import { ROUTINE_MARKER } from "../routines/routine.js";

const ROUTE = "/eve/v1/github";

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

export default defineChannel({
  routes: [
    POST(ROUTE, async (req, { receive, waitUntil }) => {
      const body = await req.text();
      const secret = process.env.GITHUB_WEBHOOK_SECRET;
      if (secret && !verifyGithubSignature(secret, body, req.headers.get("x-hub-signature-256"))) {
        return new Response("invalid signature", { status: 401 });
      }
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body) as Record<string, unknown>;
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const ev = normalizeGithubEvent(req.headers.get("x-github-event") ?? "", payload);
      if (!ev) return new Response("ignored", { status: 200 });

      waitUntil(fanOut(ev, receive));
      return new Response("ok", { status: 200 });
    }),
  ],
});
