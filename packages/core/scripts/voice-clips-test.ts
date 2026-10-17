import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SQLITE_DIR = mkdtempSync(join(tmpdir(), "oe-voice-clips-"));
delete process.env.DATABASE_URL;
process.env.OE_OPERATIONAL_PROVIDER = "sqlite";
process.env.OE_SQLITE_PATH = join(SQLITE_DIR, "voice-clips.sqlite3");

const vc = await import("../agent/channels/voice-clips.js");
const { getSettings } = await import("../agent/settings/settings.js");
const { getOperationalStore } = await import("../agent/operational/provider.js");
const { resolvePartition } = await import("../agent/memory/partition.js");

let n = 0;
function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  n++;
}

const clip = (id: string, mimeType?: string, name?: string) => ({ kind: "file" as const, id, ...(mimeType ? { mimeType } : {}), ...(name ? { name } : {}), url: `https://files.slack.com/files-pri/T1-${id}/clip` });

ok(vc.isVoiceClip(clip("F1", "audio/webm")), "audio/webm is a voice clip");
ok(vc.isVoiceClip(clip("F1", "audio/mp4")), "audio/mp4 is a voice clip");
ok(vc.isVoiceClip(clip("F1", undefined, "memo.m4a")), "an .m4a with no media type is a voice clip");
ok(!vc.isVoiceClip(clip("F1", "video/mp4", "clip.mp4")), "a video clip is not a voice clip");
ok(!vc.isVoiceClip({ kind: "image", id: "F2", mimeType: "image/png" }), "an image is not a voice clip");
ok(!vc.isVoiceClip(clip("F1", "text/plain", "notes.mp3")), "the media type wins over the extension");

ok(vc.voiceClipBody("hi", []) === "hi", "no clip ⇒ the typed text, unchanged");
ok(vc.voiceClipBody("", [{ heard: true, text: "book the room for Friday" }]) === "[voice clip] book the room for Friday", "a clip with no typed text is the transcript alone");
ok(
  vc.voiceClipBody("see below", [{ heard: true, text: "first" }, { heard: false, reason: "failed" }]) === "see below\n[voice clip] first\n[voice clip — could not be transcribed]",
  "typed text first, then one line per clip in order",
);
ok(vc.voiceClipBody("", [{ heard: false, reason: "over-cap" }]).includes("spend cap"), "an over-cap clip says so");

ok(getSettings({}).voiceClips.enabled === true, "voiceClips.enabled ships ON");

const bindable = {
  channel: { kind: "slack" },
  session: { auth: { current: { attributes: { team_id: "T1", channel_id: "D_ADA", channel_type: "im" }, principalId: "U_ADA", principalType: "slack-user" } } },
} as never;
const p = resolvePartition(bindable);

const loads: string[] = [];
const load = async (c: { id?: string; mimeType?: string }) => {
  loads.push(c.id ?? "?");
  if (c.id === "F_BROKEN") throw new Error("HTTP 404");
  return { audio: new Uint8Array([1, 2, 3]), mediaType: c.mimeType ?? "audio/mp4" };
};
const transcriber = async () => ({ text: " book the room for Friday ", model: "spacexai/grok-stt", costUsd: 0.0042 });

const heard = await vc.hearVoiceClips({ attachments: [clip("F_A", "audio/webm")], bindable, load, transcriber, enabled: true, overBudget: async () => false });
ok(heard.length === 1 && heard[0]!.heard && heard[0]!.text === "book the room for Friday", "a clip is heard, trimmed");

const rows = await getOperationalStore().listSpendLedger(p.org);
const row = rows.find((r) => r.model === "spacexai/grok-stt");
ok(row !== undefined, "a heard clip writes a spend-ledger row under the answering model");
ok(row!.principalId === "U_ADA", "…attributed to the person who sent the clip");
ok(row!.surfaceKey === p.key, "…under the conversation's own surface");
ok(row!.usdMicros === 4200, `…priced at the measured cost, not $0 (usd_micros=${row!.usdMicros})`);

const audit = await getOperationalStore().readAudit({ org: p.org, action: "voice.transcribed" });
ok(audit.length === 1, "one audit row per message");
ok(audit[0]!.principalId === "U_ADA" && (audit[0]!.detail as { heard?: number }).heard === 1, "…naming the person and the heard count");
ok(!JSON.stringify(audit[0]).includes("Friday"), "…and carrying no transcript");

loads.length = 0;
const capped = await vc.hearVoiceClips({ attachments: [clip("F_C", "audio/webm")], bindable, load, transcriber, enabled: true, overBudget: async () => true, audit: async () => {} });
ok(capped.length === 1 && !capped[0]!.heard && capped[0]!.reason === "over-cap", "over cap ⇒ not heard");
ok(loads.length === 0, "…and nothing was downloaded");

vc.resetVoiceTranscriberForTest();
const noRoute = await vc.hearVoiceClips({ attachments: [clip("F_D", "audio/webm")], bindable, load, enabled: true, overBudget: async () => false, audit: async () => {} });
ok(!noRoute[0]!.heard && noRoute[0]!.reason === "no-route", "no transcriber registered ⇒ no-route");

vc.registerVoiceTranscriber(transcriber);
const viaSlot = await vc.hearVoiceClips({ attachments: [clip("F_E", "audio/webm")], bindable, load, enabled: true, overBudget: async () => false, audit: async () => {}, record: async () => {} });
ok(viaSlot[0]!.heard, "the registered transcriber is used when none is injected");

const off = await vc.hearVoiceClips({ attachments: [clip("F_F", "audio/webm")], bindable, load, transcriber, enabled: false, audit: async () => {} });
ok(!off[0]!.heard && off[0]!.reason === "off", "the setting off ⇒ not heard");

loads.length = 0;
let call = 0;
const flaky = async () => {
  call++;
  if (call === 1) throw new Error("both routes down");
  return { text: "later", model: "m" };
};
const mixed = await vc.hearVoiceClips({
  attachments: [clip("F_BROKEN", "audio/webm"), clip("F_1", "audio/webm"), { kind: "image", id: "F_IMG", mimeType: "image/png" }, clip("F_2", "audio/webm"), clip("F_3", "audio/webm")],
  bindable,
  load,
  transcriber: flaky,
  enabled: true,
  overBudget: async () => false,
  audit: async () => {},
  record: async () => {},
});
ok(mixed.length === 4, "one outcome per voice clip; the image is not counted");
ok(!mixed[0]!.heard && mixed[0]!.reason === "failed", "a failed download ⇒ failed");
ok(!mixed[1]!.heard && mixed[1]!.reason === "failed", "a failed route ⇒ failed");
ok(mixed[2]!.heard && mixed[2]!.text === "later", "a later clip is still heard");
ok(!mixed[3]!.heard && mixed[3]!.reason === "too-many", "a fourth clip ⇒ too many");
ok(!loads.includes("F_3"), "…and the fourth clip is never downloaded");

const silent = await vc.hearVoiceClips({ attachments: [clip("F_S", "audio/webm")], bindable, load, transcriber: async () => ({ text: "  ", model: "m" }), enabled: true, overBudget: async () => false, audit: async () => {}, record: async () => {} });
ok(!silent[0]!.heard && silent[0]!.reason === "silent", "an empty transcript ⇒ no speech heard");

const big = await vc.hearVoiceClips({
  attachments: [clip("F_BIG", "audio/webm")],
  bindable,
  load: async () => {
    const e = new Error("attachment too large");
    e.name = "AttachmentOversizeError";
    throw e;
  },
  transcriber,
  enabled: true,
  overBudget: async () => false,
  audit: async () => {},
});
ok(!big[0]!.heard && big[0]!.reason === "too-large", "an oversize clip ⇒ too large");

{
  let signalSeen: AbortSignal | undefined;
  let calls = 0;
  const started = Date.now();
  const hung = await vc.hearVoiceClips({
    attachments: [clip("F_H1", "audio/webm"), clip("F_H2", "audio/webm")],
    bindable,
    load,
    transcriber: (c) => {
      calls++;
      signalSeen = c.abortSignal;
      return new Promise(() => {});
    },
    enabled: true,
    overBudget: async () => false,
    audit: async () => {},
    deadlineMs: 50,
  });
  ok(Date.now() - started < 5_000, "a hung route is cut at the message's deadline");
  ok(hung.length === 2 && hung.every((o) => !o.heard && o.reason === "failed"), "…and every clip past it is marked not transcribed");
  ok(calls === 1, "…a clip after the deadline is not even tried");
  ok(signalSeen?.aborted === true, "…and the transcriber got the deadline as its abort signal, so the route stops too");
}

{
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (m: unknown) => void warned.push(String(m));
  const open = await vc.hearVoiceClips({ attachments: [clip("F_O", "audio/webm")], bindable, load, transcriber, enabled: true, overBudget: async () => { throw new Error("store down"); }, audit: async () => {}, record: async () => {} });
  console.warn = orig;
  ok(open[0]!.heard, "an unreadable cap reads as under cap, so a store hiccup does not make the agent deaf");
  ok(warned.some((m) => m.includes("failed OPEN")), "…and it says so in a warning");
}

{
  const base = { bindable, transcriber, enabled: true, overBudget: async () => false, audit: async () => {}, record: async () => {} };
  const notBytes = await vc.hearVoiceClips({ ...base, attachments: [clip("F_X1", "audio/webm")], load: async () => ({ audio: "x" }) as never });
  ok(!notBytes[0]!.heard && notBytes[0]!.reason === "failed", "a loader that returns non-bytes ⇒ failed");
  const nothing = await vc.hearVoiceClips({ ...base, attachments: [clip("F_X2", "audio/webm")], load: async () => undefined as never });
  ok(!nothing[0]!.heard && nothing[0]!.reason === "failed", "a loader that returns nothing ⇒ failed");
  const noText = await vc.hearVoiceClips({ ...base, attachments: [clip("F_X3", "audio/webm")], load, transcriber: async () => ({ model: "m" }) as never });
  ok(!noText[0]!.heard && noText[0]!.reason === "silent", "a transcriber with no text ⇒ no speech heard");
  const noAnswer = await vc.hearVoiceClips({ ...base, attachments: [clip("F_X4", "audio/webm")], load, transcriber: async () => undefined as never });
  ok(!noAnswer[0]!.heard && noAnswer[0]!.reason === "failed", "a transcriber that returns nothing ⇒ failed");
}

{
  const rows: Record<string, unknown>[] = [];
  await vc.hearVoiceClips({ attachments: [clip("F_OFF", "audio/webm")], bindable, load, transcriber, enabled: false, audit: async (d) => void rows.push(d) });
  ok(rows.length === 1 && rows[0]!.reason === "off" && rows[0]!.heard === 0, "the setting off ⇒ one voice.transcribed row with reason off");
}

ok((await vc.hearVoiceClips({ attachments: [{ kind: "image", id: "F", mimeType: "image/png" }], bindable, load, transcriber })).length === 0, "a message with no clip ⇒ no outcome");

console.log(`✓ voice-clips: ${n} assertions passed (clip detection · body · shipped default · attributed spend + audit on a real store · cap · failure lines)`);
process.exit(0);
