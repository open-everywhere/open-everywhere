import { createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const env = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    console.error(`[oe-meeting-bot] missing ${name}`);
    process.exit(2);
  }
  return v;
};

const MEETING_URL = env("OE_MEETING_URL");
const PLATFORM = env("OE_MEETING_PLATFORM");
const BOT_NAME = env("OE_MEETING_BOT_NAME", "Meeting notetaker");
const CALLBACK = env("OE_MEETING_CALLBACK");
const SECRET = env("OE_MEETING_SECRET");
delete process.env.OE_MEETING_SECRET;
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "OE_MEETING_SECRET"));
const DEADLINE_MS = Number(env("OE_MEETING_DEADLINE_MS", String(Date.now() + 117 * 60_000)));
const ALONE_MINUTES = Number(env("OE_MEETING_ALONE_MINUTES", "5"));
const TRANSCRIBE = env("OE_MEETING_TRANSCRIBE", "gateway");
const STT_CMD = process.env.OE_MEETING_STT_CMD ?? "";
const LOBBY_MINUTES = 10;

const KEY = SECRET.startsWith("whsec_") ? Buffer.from(SECRET.slice("whsec_".length), "base64") : Buffer.from(SECRET, "utf8");

async function send(event, attempt = 0) {
  const body = JSON.stringify(event);
  const id = `msg_${randomUUID().replace(/-/g, "")}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", KEY).update(`${id}.${ts}.${body}`, "utf8").digest("base64");
  try {
    const res = await fetch(CALLBACK, {
      method: "POST",
      headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (res.status >= 500 && attempt === 0) return await send(event, 1);
    if (!res.ok) console.error(`[oe-meeting-bot] callback ${event.type} answered ${res.status}`);
    return res.ok;
  } catch (err) {
    if (attempt === 0) return await send(event, 1);
    console.error(`[oe-meeting-bot] callback ${event.type} failed: ${String(err)}`);
    return false;
  }
}

async function transcribeInBox(base64) {
  if (STT_CMD === "") throw new Error("the box transcription route needs OE_MEETING_STT_CMD in the bot image");
  const dir = mkdtempSync(join(tmpdir(), "oe-chunk-"));
  const file = join(dir, "chunk.webm");
  writeFileSync(file, Buffer.from(base64, "base64"));
  return await new Promise((resolve, reject) => {
    execFile(STT_CMD, [file], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 120_000, env: CHILD_ENV }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });
}

let queue = Promise.resolve();
let chunksSeen = 0;
function sendChunk(seq, base64, meta) {
  chunksSeen = Math.max(chunksSeen, seq + 1);
  const attendees = Array.isArray(meta?.attendees) && meta.attendees.length > 0 ? { attendees: meta.attendees } : {};
  const speakers = Array.isArray(meta?.speakers) && meta.speakers.length > 0 ? { speakers: meta.speakers } : {};
  queue = queue.then(async () => {
    if (TRANSCRIBE === "box") {
      try {
        await send({ type: "chunk", seq, text: await transcribeInBox(base64), ...attendees });
      } catch (err) {
        console.error(`[oe-meeting-bot] in-box transcription of chunk ${seq} failed: ${String(err)}`);
      }
      return;
    }
    await send({ type: "chunk", seq, audio: { mediaType: "audio/webm", base64 }, ...speakers, ...attendees });
  });
  return queue;
}

async function firstVisible(page, selectors, timeout) {
  const locators = selectors.map((sel) => page.locator(sel).first());
  try {
    return await Promise.any(locators.map(async (l) => (await l.waitFor({ state: "visible", timeout }), l)));
  } catch {
    return undefined;
  }
}

async function clickFirst(page, selectors, timeout = 3_000) {
  const el = await firstVisible(page, selectors, timeout);
  if (el === undefined) return false;
  await el.click().catch(() => {});
  return true;
}

async function joinMeeting(page) {
  await page.goto(MEETING_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (PLATFORM === "teams") {
    await clickFirst(page, ['button:has-text("Continue on this browser")', 'button:has-text("Join on the web instead")'], 10_000);
  }
  await clickFirst(page, ['button:has-text("Got it")', 'button:has-text("Dismiss")']);
  const name = await firstVisible(page, ['input[aria-label="Your name"]', 'input[placeholder="Your name"]', 'input[placeholder*="name" i]'], 30_000);
  if (name !== undefined) await name.fill(BOT_NAME);
  const asked = await clickFirst(page, ['button:has-text("Ask to join")', 'button:has-text("Join now")', 'button:has-text("Join")'], 30_000);
  if (!asked) return "failed";
  await send({ type: "status", state: "lobby" });
  const leave = page.locator('[aria-label="Leave call"], [aria-label="Leave"], #hangup-button, button:has-text("Leave")').first();
  const deadline = Date.now() + LOBBY_MINUTES * 60_000;
  while (Date.now() < deadline) {
    if (await leave.waitFor({ state: "visible", timeout: 2_000 }).then(() => true, () => false)) return "admitted";
    const text = (await page.textContent("body").catch(() => "")) ?? "";
    if (/denied your request|can't join this (video )?call|someone in the meeting denied|You've been removed|not allowed to join/i.test(text)) return "refused";
    await page.waitForTimeout(2_000);
  }
  return "refused";
}

async function othersPresent(page) {
  if (PLATFORM === "meet") {
    const n = await page.locator("[data-participant-id]").count().catch(() => 0);
    return n === 0 ? undefined : n > 1;
  }
  const text = (await page.textContent("body").catch(() => "")) ?? "";
  if (/Waiting for others to join|You're the only one here/i.test(text)) return false;
  return undefined;
}

let browser;
let page;
let capturing = false;
let ending;

function finish(reason) {
  ending ??= (async () => {
    if (capturing && page !== undefined) {
      await Promise.race([page.evaluate(() => window.__oeStopCapture()).catch(() => {}), new Promise((r) => setTimeout(r, 15_000))]);
    }
    await Promise.race([queue.catch(() => {}), new Promise((r) => setTimeout(r, 60_000))]);
    await send({ type: "ended", chunks: chunksSeen, reason });
    await browser?.close().catch(() => {});
  })();
  return ending;
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    void finish("terminated").finally(() => process.exit(0));
  });
}

async function main() {
  browser = await chromium.launch({
    headless: true,
    env: CHILD_ENV,
    args: ["--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage", "--no-sandbox"],
  });
  let reason = "ended";
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
    await page.exposeFunction("oeChunk", (seq, base64, meta) => sendChunk(seq, base64, meta));
    const here = dirname(fileURLToPath(import.meta.url));
    await page.addInitScript({ content: ["cut-rule.js", "speakers.js", "capture.js"].map((f) => readFileSync(join(here, f), "utf8")).join("\n;\n") });

    const joined = await joinMeeting(page);
    if (joined !== "admitted") {
      await send({ type: "status", state: joined === "refused" ? "refused" : "failed", detail: joined === "refused" ? "lobby-refused" : "join-button-missing" });
      reason = joined;
      return;
    }
    await send({ type: "status", state: "admitted" });
    await page.evaluate((opts) => window.__oeStartCapture(opts), { platform: PLATFORM, botName: BOT_NAME });
    capturing = true;

    const leave = page.locator('[aria-label="Leave call"], [aria-label="Leave"], #hangup-button, button:has-text("Leave")').first();
    let aloneSince;
    for (;;) {
      await page.waitForTimeout(10_000);
      if (Date.now() > DEADLINE_MS) {
        reason = "cap";
        break;
      }
      if (!(await leave.waitFor({ state: "visible", timeout: 2_000 }).then(() => true, () => false))) {
        reason = "meeting-ended";
        break;
      }
      const others = await othersPresent(page);
      if (others === false) {
        aloneSince ??= Date.now();
        if (Date.now() - aloneSince > ALONE_MINUTES * 60_000) {
          reason = "alone";
          break;
        }
      } else {
        aloneSince = undefined;
      }
    }
    await leave.click({ timeout: 5_000 }).catch(() => {});
  } catch (err) {
    console.error(`[oe-meeting-bot] failed: ${err instanceof Error ? err.name : "error"}`);
    if (ending === undefined) await send({ type: "status", state: "failed", detail: "page-error" });
    reason = "failed";
  } finally {
    await finish(reason);
  }
}

await main();
process.exit(0);
