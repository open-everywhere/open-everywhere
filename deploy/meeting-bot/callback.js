import { createHmac, randomUUID } from "node:crypto";

export function createCallback(url, secret) {
  const key = secret.startsWith("whsec_") ? Buffer.from(secret.slice("whsec_".length), "base64") : Buffer.from(secret, "utf8");
  async function send(event, attempt = 0) {
    const body = JSON.stringify(event);
    const id = `msg_${randomUUID().replace(/-/g, "")}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`, "utf8").digest("base64");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` },
        body,
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status >= 500 && attempt === 0) return await send(event, 1);
      if (!res.ok) console.error(`[oe-meeting-bot] callback ${event.type} answered ${res.status}`);
      return { ok: res.ok, body: await res.json().catch(() => undefined) };
    } catch (err) {
      if (attempt === 0) return await send(event, 1);
      console.error(`[oe-meeting-bot] callback ${event.type} failed: ${String(err)}`);
      return { ok: false, body: undefined };
    }
  }
  return send;
}
