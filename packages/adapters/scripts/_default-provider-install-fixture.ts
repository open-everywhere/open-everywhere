const mode = process.argv[2];
let sent = 0;
const foreign = Object.assign((id: string) => ({ modelId: id, doGenerate: async () => (sent++, "f") }), {});
(globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER = mode === "null" ? null : foreign;
const errors: string[] = [];
const realError = console.error;
console.error = (...a: unknown[]) => void errors.push(a.map(String).join(" "));
try {
  await import("../agent/model/gateway.js");
} finally {
  console.error = realError;
}
const core = await import("@open-everywhere/core/agent/adapter-api.js");
core.overrideSettingsForTest({ models: { dataPolicy: { zeroRetention: true } } });
const dp = (globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }).AI_SDK_DEFAULT_PROVIDER as ((id: string) => { doGenerate(o: unknown): Promise<unknown> }) | null;
const own = dp !== null && (dp as unknown as Record<symbol, unknown>)[Symbol.for("open-everywhere.gateway.policyProvider")] === true;
let refused = "";
if (mode !== "null" && dp !== null) {
  try {
    await dp("x").doGenerate({ prompt: [] });
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
}
console.log(JSON.stringify({ kept: dp !== null && dp !== foreign && mode !== "null", own, refused, sent, errors }));
