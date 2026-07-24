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
  const real = await scope.resolveEveInternalsFrom(scope.defaultEveRoot());
  ok(real !== null, "resolveEveInternalsFrom(defaultEveRoot()) resolves against the installed eve (not null)");
  ok(typeof real?.contextStorage.getStore === "function", "the resolved internals still expose contextStorage.getStore");
  ok(real?.ChannelKey !== undefined, "the resolved internals still expose ChannelKey");
}

console.log(`✓ connector-scope-internals: ${passed} assertions passed`);
