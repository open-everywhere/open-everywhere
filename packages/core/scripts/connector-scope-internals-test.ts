import "./_register-test-config.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
function ok(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  passed++;
}

const scope = await import("../agent/access/connector-scope.js");

const warned: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]): void => {
  warned.push(String(args[0]));
};
const status = await scope.whenEveChannelReachSettled();
console.warn = realWarn;

ok(status === "available", `boot probe settles "available" in this environment (got "${status}")`);
ok(scope.eveChannelReachStatus() === "available", "eveChannelReachStatus() reflects the settled status");
const bootLines = warned.filter((w) => w.includes("[open-everywhere:connector-scope:boot]"));
ok(bootLines.length === 1, `exactly one boot line is logged, not per-call spam (got ${bootLines.length})`);
ok(bootLines[0]?.includes("channel-kind ALS reach: available") === true, "the boot line reports the reach as available");
ok(bootLines[0]?.includes("unavailable") !== true, "the boot line for a working reach never mentions 'unavailable'");

{
  const missingRoot = join(tmpdir(), "oe-connector-scope-internals-test-missing-does-not-exist");
  const missing = await scope.resolveEveInternalsFrom(missingRoot);
  ok(missing === null, "a root with neither internal file present resolves null (not a throw)");
}

{
  const fakeRoot = mkdtempSync(join(tmpdir(), "oe-connector-scope-internals-test-"));
  try {
    mkdirSync(join(fakeRoot, "dist/src/context"), { recursive: true });
    mkdirSync(join(fakeRoot, "dist/src/runtime/sessions"), { recursive: true });
    writeFileSync(join(fakeRoot, "dist/src/context/container.js"), "exports.notContextStorage = {};\n");
    writeFileSync(
      join(fakeRoot, "dist/src/runtime/sessions/runtime-context-keys.js"),
      "exports.NotChannelKey = {};\n",
    );
    const reshaped = await scope.resolveEveInternalsFrom(fakeRoot);
    ok(reshaped === null, "a root with the right files but the wrong exports resolves null (not a throw)");
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
  }
}

{
  const thrown = await scope.resolveEveInternalsSafe(() => {
    throw new Error("Cannot find module 'eve/package.json' (simulated hosted bundle)");
  });
  ok(thrown === null, "a throwing root resolver resolves null via resolveEveInternalsSafe (not a process crash)");
  const safeReal = await scope.resolveEveInternalsSafe(scope.defaultEveRoot);
  ok(safeReal !== null, "resolveEveInternalsSafe(defaultEveRoot) still resolves against a real installed eve");
}

{
  const real = await scope.resolveEveInternalsFrom(scope.defaultEveRoot());
  ok(real !== null, "resolveEveInternalsFrom(defaultEveRoot()) resolves against the installed eve (not null)");
  ok(typeof real?.contextStorage.getStore === "function", "the resolved internals still expose contextStorage.getStore");
  ok(real?.ChannelKey !== undefined, "the resolved internals still expose ChannelKey");
}

{
  // eve's REAL context shape only: its own container, its own store and its own setChannelContext.
  const { createRequire } = await import("node:module");
  const { dirname: dirOf } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const eveRoot = dirOf(createRequire(import.meta.url).resolve("eve/package.json"));
  const eveUrl = (rel: string) => pathToFileURL(join(eveRoot, rel)).href;
  const { ContextContainer, contextStorage } = (await import(eveUrl("dist/src/context/container.js"))) as {
    ContextContainer: new () => unknown;
    contextStorage: { run<T>(container: unknown, fn: () => T): T };
  };
  const { setChannelContext } = (await import(eveUrl("dist/src/execution/channel-context.js"))) as {
    setChannelContext: (container: unknown, adapter: unknown, opts: { channelName?: string }) => void;
  };
  const { defineChannel } = await import("eve/channels");
  const { platformFromKind } = await import("../agent/identity/platform.js");
  const auth = { current: { principalId: "U1", principalType: "user", authenticator: "fixture", attributes: {} }, initiator: null };
  const kindOn = async (adapter: unknown, channelName: string): Promise<string | undefined> => {
    const container = new ContextContainer();
    setChannelContext(container, adapter, { channelName });
    const ctx = await contextStorage.run(container, () => scope.surfaceContextFromAuth(auth as never));
    return (ctx?.channel as { kind?: string } | undefined)?.kind;
  };
  const unified = defineChannel({ events: { "turn.started": async () => {} } } as never) as unknown as { adapter: { kind?: string } };
  ok(unified.adapter.kind === "defineChannel", `(precondition) eve's adapter kind is its TYPE, not the channel (got ${String(unified.adapter.kind)})`);
  const unifiedKind = await kindOn(unified.adapter, "unified");
  ok(platformFromKind(unifiedKind) === "unified", `🔴 a turn on the unified channel resolves the "unified" platform, not the adapter type (got ${String(unifiedKind)})`);
  const slackKind = await kindOn({ kind: "http" }, "slack");
  ok(platformFromKind(slackKind) === "slack", `🔴 a turn on an http channel named slack resolves "slack" (got ${String(slackKind)})`);
}

console.log(`✓ connector-scope-internals: ${passed} assertions passed`);
