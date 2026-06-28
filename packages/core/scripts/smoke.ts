const BASE = (process.argv[2] ?? process.env.OE_SMOKE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const MESSAGE = process.env.OE_SMOKE_MESSAGE ?? "Reply with exactly the word: pong";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { ...(BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {}), ...extra };
}

function fail(msg: string): never {
  console.error(`✗ smoke: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  console.log(`smoke → ${BASE}`);

  let health: Response;
  try {
    health = await fetch(`${BASE}/eve/v1/health`, { headers: headers() });
  } catch (err) {
    fail(`cannot reach ${BASE}/eve/v1/health — is the server running? (${String(err)})`);
  }
  if (!health.ok) fail(`health returned ${health.status} (auth/preview-protection? set VERCEL_AUTOMATION_BYPASS_SECRET)`);
  console.log("✓ health ok");

  const started = Date.now();
  const res = await fetch(`${BASE}/eve/v1/session`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ message: MESSAGE }),
  });
  if (!res.ok) fail(`POST /eve/v1/session returned ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const body = (await res.json()) as { sessionId?: string };
  const sessionId = body.sessionId;
  if (!sessionId) fail(`session response had no sessionId: ${JSON.stringify(body).slice(0, 400)}`);
  console.log(`✓ session created: ${sessionId}`);

  const stream = await fetch(`${BASE}/eve/v1/session/${sessionId}/stream`, { headers: headers() });
  if (!stream.ok || !stream.body) fail(`stream returned ${stream.status}`);
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > 200_000) break;
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (text.trim().length === 0) fail(`stream produced no output after ${elapsed}s (model/gateway misconfigured?)`);

  console.log(`✓ reply received in ${elapsed}s (${text.length} bytes)`);
  console.log("✓ smoke passed — boot → model → reply loop is live.");
}

main().catch((err) => fail(String(err)));
