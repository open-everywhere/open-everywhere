import assert from "node:assert/strict";
import {
  assertTranscriptionRole,
  parseTranscriptionBody,
  roleDisclosure,
  routeTransport,
  transcribeWithFallback,
  DEEPINFRA_SECRET,
  roleHostPlaneHosts,
  storeOnlySecret,
  type TimedTranscript,
  type TranscribeRequest,
  type TranscriptionRoleSpec,
} from "../agent/model/transcription-routes.js";
import { registerGatewayMeetingModels, stackTranscriptionRoute, voiceClipTranscriber } from "../agent/model/meeting-gateway.js";
import { voiceTranscriber } from "@open-everywhere/core/agent/adapter-api.js";
import { GATEWAY_TARGET_HOST } from "../agent/model/gateway.js";

let n = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  n++;
}

const AUDIO: TranscribeRequest = { audio: new Uint8Array([1, 2, 3, 4]), mediaType: "audio/webm" };
const GW_ROLE: TranscriptionRoleSpec = { primary: { via: "gateway", id: "lab-a/stt" }, fallback: { via: "gateway", id: "lab-b/stt" } };
const timed = (text: string): TimedTranscript => ({ text, segments: [], words: [] });

{
  const calls: string[] = [];
  const warned: string[] = [];
  const run = transcribeWithFallback(GW_ROLE, {
    gateway: async (id) => {
      calls.push(id);
      if (id === "lab-a/stt") throw new Error("Providers considered: azure");
      return timed("from b");
    },
    warn: (m) => warned.push(m),
  });
  const r = await run(AUDIO);
  ok(r.text === "from b" && r.answeredBy === "fallback" && r.route.id === "lab-b/stt", "a primary failure falls through to the fallback route");
  ok(calls.join(",") === "lab-a/stt,lab-b/stt", "the primary is tried first, then the fallback, once each");
  ok(warned.length === 1 && warned[0]!.includes("gateway:lab-a/stt") && warned[0]!.includes("gateway:lab-b/stt"), "the fall-through is reported with both routes");
}
{
  const calls: string[] = [];
  const run = transcribeWithFallback(GW_ROLE, { gateway: async (id) => (calls.push(id), timed("from a")) });
  const r = await run(AUDIO);
  ok(r.answeredBy === "primary" && calls.join(",") === "lab-a/stt", "a healthy primary answers alone; the fallback is not called");
}
{
  const run = transcribeWithFallback(GW_ROLE, { gateway: async (id) => { throw new Error(`down ${id}`); }, warn: () => {} });
  await assert.rejects(run(AUDIO), (e: Error) => e.message.includes("both routes") && e.message.includes("down lab-a/stt") && e.message.includes("down lab-b/stt"));
  n++;
}
{
  const run = transcribeWithFallback({ primary: GW_ROLE.primary }, { gateway: async () => { throw new Error("down"); }, warn: () => {} });
  await assert.rejects(run(AUDIO), /failed on gateway:lab-a\/stt: down/);
  n++;
}
{
  const run = transcribeWithFallback(GW_ROLE, {
    attemptTimeoutMs: 50,
    warn: () => {},
    gateway: (id, req) =>
      id === "lab-a/stt"
        ? new Promise<TimedTranscript>(() => {})
        : Promise.resolve(timed("late b")),
  });
  const r = await run(AUDIO);
  ok(r.answeredBy === "fallback" && r.text === "late b", "a primary that hangs past the attempt limit falls through");
}
{
  const calls: string[] = [];
  const ctl = new AbortController();
  const run = transcribeWithFallback(GW_ROLE, {
    gateway: async (id) => {
      calls.push(id);
      ctl.abort();
      throw new Error("aborted by caller");
    },
  });
  await assert.rejects(run({ ...AUDIO, abortSignal: ctl.signal }), /aborted by caller/);
  ok(calls.length === 1, "a caller abort stops the call without the fallback");
}

{
  const calls: string[] = [];
  const hear = voiceClipTranscriber(GW_ROLE, {
    warn: () => {},
    gateway: async (id) => {
      calls.push(id);
      if (id === "lab-a/stt") throw new Error("Providers considered: azure");
      return { ...timed("book the room"), costUsd: 0.003 };
    },
  });
  const r = await hear({ audio: AUDIO.audio, mediaType: "audio/webm" });
  ok(calls.join(",") === "lab-a/stt,lab-b/stt", "a voice clip walks the role's primary, then its fallback");
  ok(r.text === "book the room" && r.model === "lab-b/stt", "the spend row names the model that ANSWERED, not the primary");
  ok(r.costUsd === 0.003, "the provider's measured cost is carried to the spend row");
}
{
  const ctl = new AbortController();
  let seen: AbortSignal | undefined;
  const hear = voiceClipTranscriber({ primary: GW_ROLE.primary }, { gateway: async (_id, req) => ((seen = req.abortSignal), timed("ok")) });
  await hear({ audio: AUDIO.audio, mediaType: "audio/webm", abortSignal: ctl.signal });
  ctl.abort();
  ok(seen?.aborted === true, "the voice clip's deadline signal reaches the route");
}
{
  registerGatewayMeetingModels({ id: "lab/utility" } as never);
  ok(voiceTranscriber() === undefined, "no transcription role ⇒ no voice-clip transcriber registers");
  registerGatewayMeetingModels({ id: "lab/utility" } as never, GW_ROLE);
  ok(typeof voiceTranscriber() === "function", "the app's transcription role registers the voice-clip transcriber at boot, with no app change");
}

{
  const d = roleDisclosure(GW_ROLE);
  ok(d.includes("`lab-a/stt`") && d.includes("If that fails") && d.includes("`lab-b/stt`"), "the disclosure names both routes, in the order they are tried");
  const local = roleDisclosure({ primary: { via: "self-hosted", id: "Qwen/Qwen3-ASR-1.7B", baseUrl: "http://qwen3-asr:8000/v1" } });
  ok(local.includes("own speech server at qwen3-asr") && !local.includes("If that fails"), "a one-route role names its one place");
  const di = roleDisclosure({ primary: { via: "deepinfra", id: "Qwen/Qwen3-ASR-1.7B" } });
  ok(di.includes("DeepInfra (api.deepinfra.com)"), "a DeepInfra route names DeepInfra");
}

assert.throws(() => assertTranscriptionRole({ primary: { via: "self-hosted", id: "m" } }), /needs baseUrl/);
assert.throws(() => assertTranscriptionRole({ primary: { via: "gateway", id: "m", baseUrl: "http://x" } }), /self-hosted route only/);
assert.throws(() => assertTranscriptionRole({ primary: { via: "self-hosted", id: "m", baseUrl: "http://u:p@x/v1" } }), /credentials/);
assert.throws(() => assertTranscriptionRole({ primary: { via: "self-hosted", id: "m", baseUrl: "file:///x" } }), /http or https/);
assert.throws(() => assertTranscriptionRole({ primary: { via: "gateway", id: " " } }), /empty/);
n += 5;

{
  const di = parseTranscriptionBody({
    text: " hello there ",
    segments: [{ id: 0, start: 0.5, end: 1.4, text: "hello there" }],
    words: [{ start: 0.5, end: 0.9, text: "hello" }, { start: 0.9, end: 1.4, text: "there" }, { start: "x", end: 2, text: "bad" }],
    duration: 1.5,
    inference_status: { cost: 0.0000112 },
  });
  ok(di.text === "hello there" && di.segments.length === 1 && di.words.length === 2, "DeepInfra's body: text, segments and words; a span without numeric times is dropped");
  ok(di.words[1]!.startSecond === 0.9 && di.words[1]!.endSecond === 1.4 && di.costUsd === 0.0000112 && di.durationSeconds === 1.5, "word times, cost and duration are read");
  const segWords = parseTranscriptionBody({ text: "a b", segments: [{ start: 0, end: 1, text: "a" }, { start: 1, end: 2, text: "b" }] });
  ok(segWords.words.length === 2, "one-word segments count as word timestamps (the Gateway's grok-stt shape)");
  const plain = parseTranscriptionBody({ text: "just text" });
  ok(plain.words.length === 0 && plain.segments.length === 0, "a body with no timestamps gives empty spans, never invented ones");
  assert.throws(() => parseTranscriptionBody({ segments: [] }), /no text/);
  n++;
}

{
  const seen: { url: string; auth: string | null; fields: string[] }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const form = init.body as FormData;
    seen.push({ url, auth: new Headers(init.headers).get("authorization"), fields: [...form.keys()] });
    return new Response(JSON.stringify({ text: "hi", words: [{ start: 0, end: 0.3, text: "hi" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const secretsAsked: string[] = [];
  const t = routeTransport({ via: "deepinfra", id: "Qwen/Qwen3-ASR-1.7B" }, { fetch: fakeFetch, secret: async (name) => (secretsAsked.push(name), "k-test") });
  const r = await t(AUDIO);
  ok(seen[0]!.url === "https://api.deepinfra.com/v1/inference/Qwen/Qwen3-ASR-1.7B", "DeepInfra: the native inference endpoint for the model");
  ok(seen[0]!.auth === "Bearer k-test" && secretsAsked.join() === DEEPINFRA_SECRET, "DeepInfra: the key is the fixed secret-store name, as a bearer token");
  ok(seen[0]!.fields.join() === "audio" && r.words[0]!.text === "hi", "DeepInfra: the audio goes as the `audio` form field; the words come back");

  const failing = routeTransport({ via: "deepinfra", id: "Qwen/Qwen3-ASR-1.7B" }, {
    fetch: (async () => new Response("echo of secret request", { status: 503 })) as unknown as typeof fetch,
    secret: async () => "k",
  });
  await assert.rejects(failing(AUDIO), (e: Error) => e.message === "HTTP 503 from api.deepinfra.com");
  n++;
}

{
  const seen: { url: string; form: FormData }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, form: init.body as FormData });
    return new Response(JSON.stringify({ text: "ok", segments: [{ start: 0, end: 2, text: "ok then" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const t = routeTransport({ via: "self-hosted", id: "Qwen/Qwen3-ASR-1.7B", baseUrl: "http://qwen3-asr:8000/v1/" }, { fetch: fakeFetch });
  const r = await t({ ...AUDIO, prompt: "Ada, Grace" });
  const f = seen[0]!.form;
  ok(seen[0]!.url === "http://qwen3-asr:8000/v1/audio/transcriptions", "self-hosted: the OpenAI-compatible path under the base URL");
  ok(f.get("model") === "Qwen/Qwen3-ASR-1.7B" && f.get("response_format") === "verbose_json", "self-hosted: the served model and verbose_json");
  ok(f.getAll("timestamp_granularities[]").join() === "word,segment" && f.get("prompt") === "Ada, Grace", "self-hosted: asks for word and segment timestamps, and forwards the prompt");
  ok(r.segments.length === 1 && r.words.length === 0, "self-hosted: a multi-word segment is a segment, not a word");
}

{
  const ids: string[] = [];
  const route = stackTranscriptionRoute(GW_ROLE, {
    gateway: async (id) => {
      ids.push(id);
      if (id === "lab-a/stt") throw new Error("outage");
      return { text: "hello", segments: [{ text: "hello", startSecond: 0.1, endSecond: 0.4 }], words: [{ text: "hello", startSecond: 0.1, endSecond: 0.4 }] };
    },
    warn: () => {},
  });
  ok(route.id === "gateway" && route.disclosure === roleDisclosure(GW_ROLE), "the meeting route keeps the policy id and shows the role's own disclosure");
  const input = { kind: "audio" as const, mediaType: "audio/webm", data: new Uint8Array([9]) };
  ok((await route.transcribe(input, { model: "ignored/model", scope: "slack/T/C" })) === "hello", "the core seam gets the fallback's text");
  ok(ids.join() === "lab-a/stt,lab-b/stt" && !ids.includes("ignored/model"), "the policy's model is not read: only the role's routes are called");
  const t = await route.transcribeTimed(input, { scope: "slack/T/C" });
  ok(t.words.length === 1 && t.words[0]!.startSecond === 0.1 && t.answeredBy === "fallback", "transcribeTimed keeps the word timestamps and says which route answered");
  await assert.rejects(route.transcribe({ kind: "text", text: "x" }, { scope: "s" }), /transcribes audio/);
  n++;
}

{
  ok((await storeOnlySecret("K", async () => ({ value: "from-db", source: "db" }))) === "from-db", "a key in the secret store resolves");
  await assert.rejects(storeOnlySecret("K", async () => ({ value: "from-env", source: "env" })), /resolves only from the environment.*oe secret set K/);
  n++;
}

{
  const hosts = roleHostPlaneHosts({ primary: { via: "deepinfra", id: "Qwen/Qwen3-ASR-1.7B" }, fallback: { via: "self-hosted", id: "m", baseUrl: "http://qwen3-asr:8000/v1" } });
  ok(hosts[0] === GATEWAY_TARGET_HOST && hosts.includes("api.deepinfra.com") && hosts.includes("qwen3-asr") && hosts.length === 3, "a role's host-plane push declares the gateway host and both route hosts (the proxy replaces, never merges)");
  ok(roleHostPlaneHosts(GW_ROLE).join() === GATEWAY_TARGET_HOST, "a gateway-only role declares the gateway host alone");
  const declared: string[][] = [];
  const spy = (hosts: readonly string[]): undefined => (declared.push([...hosts]), undefined);
  transcribeWithFallback({ primary: { via: "deepinfra", id: "Qwen/Qwen3-ASR-1.7B" }, fallback: { via: "self-hosted", id: "m", baseUrl: "http://qwen3-asr:8000/v1" } }, { hostPlane: spy });
  ok(declared.length === 1 && declared[0]!.join() === [GATEWAY_TARGET_HOST, "api.deepinfra.com", "qwen3-asr"].join(), "transcribeWithFallback declares the role's union once");
  routeTransport({ via: "deepinfra", id: "Qwen/Qwen3-ASR-1.7B" }, { hostPlane: spy });
  ok(declared[1]![0] === GATEWAY_TARGET_HOST && declared[1]!.includes("api.deepinfra.com"), "a standalone route declares the gateway host first, too");
}

console.log(`✓ transcription-routes-test: ${n} assertions`);
