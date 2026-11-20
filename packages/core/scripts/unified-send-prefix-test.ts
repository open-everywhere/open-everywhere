// A unified seat's continuation token reaches OE in two shapes. eve's hook, tool and instruction
// frame hands over the namespaced form (`unified:<token>`). A channel handler's `continuation.token`
// is the bare form. This suite pins that every road from a seat token to its domain, its window and
// its generation resolves through one resolver (`seatWindowKey`), and so resolves on both shapes.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { _setDeploymentIdentityForTest } from "../agent/identity/deployment-identity.js";

process.env.OE_SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "oe-unified-send-prefix-")), "ops.sqlite3");
_setDeploymentIdentityForTest({ org: undefined });

const {
  UNIFIED_SEND_PREFIX,
  stripUnifiedSendPrefix,
  seatWindowKey,
  formatWindowToken,
  threadSeatWindowId,
  workWindowId,
  isTaskWindowToken,
  isThreadSeatWindowToken,
  isWorkWindowToken,
} = await import("../agent/channels/window-key.js");
const { unifiedDomainFromToken, unifiedWindowFromToken, unifiedGenerationFromToken, unifiedSupervisorToken, isUnifiedSupervisorToken } = await import(
  "../agent/channels/unified-supervisor.js"
);
const { auditLabels, redriveSeatOf } = await import("../agent/channels/unified.js");
const { resolveOwnWindowToken } = await import("../agent/access/delegation-mount.js");

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = <T>(actual: T, expected: T, label: string) => {
  assert.deepEqual(actual, expected, label);
  n++;
};

const DOMAIN = "payments";
const standing = unifiedSupervisorToken(DOMAIN, 3);
const explicit = formatWindowToken({ domain: DOMAIN, windowId: "slack/C_PAY", generation: 4 });
const thread = formatWindowToken({ domain: DOMAIN, windowId: threadSeatWindowId("slack-T1-C_PAY", "1700000000.000100"), generation: 1 });
const work = formatWindowToken({ domain: DOMAIN, windowId: workWindowId(DOMAIN), generation: 2 });
const task = formatWindowToken({ domain: DOMAIN, windowId: "t/slack/abc", generation: 1 });

{
  eq(UNIFIED_SEND_PREFIX, "unified:", "the send prefix is eve's unified channel namespace");
  eq(stripUnifiedSendPrefix(`unified:${standing}`), standing, "the strip removes the namespace");
  eq(stripUnifiedSendPrefix(standing), standing, "the strip leaves a bare token as it is");
  eq(stripUnifiedSendPrefix(undefined), undefined, "the strip leaves a non-string as it is");
  ok(standing.startsWith("oe-dom:"), "a bare window token starts with `oe-dom:`, so it never starts with the send prefix");
}

for (const [label, token, windowId, generation] of [
  ["standing", standing, DOMAIN, 3],
  ["explicit window", explicit, "slack/C_PAY", 4],
  ["thread seat", thread, threadSeatWindowId("slack-T1-C_PAY", "1700000000.000100"), 1],
  ["work session", work, workWindowId(DOMAIN), 2],
  ["task", task, "t/slack/abc", 1],
] as const) {
  const prefixed = `unified:${token}`;
  eq(seatWindowKey(prefixed), seatWindowKey(token), `🔴 ${label}: seatWindowKey resolves the namespaced token to the bare token's key`);
  eq(unifiedDomainFromToken(prefixed), DOMAIN, `🔴 ${label}: unifiedDomainFromToken resolves the domain on the namespaced token`);
  eq(unifiedDomainFromToken(token), DOMAIN, `${label}: …and on the bare token`);
  eq(unifiedWindowFromToken(prefixed), windowId, `🔴 ${label}: unifiedWindowFromToken resolves the window on the namespaced token`);
  eq(unifiedGenerationFromToken(prefixed), generation, `🔴 ${label}: unifiedGenerationFromToken resolves the generation on the namespaced token`);
}

{
  ok(isThreadSeatWindowToken(`unified:${thread}`), "🔴 isThreadSeatWindowToken reads the namespaced token");
  ok(isTaskWindowToken(`unified:${task}`), "🔴 isTaskWindowToken reads the namespaced token");
  ok(isWorkWindowToken(`unified:${work}`), "isWorkWindowToken reads the namespaced token");
  ok(!isThreadSeatWindowToken(`unified:${standing}`) && !isTaskWindowToken(`unified:${standing}`), "NEGATIVE CONTROL: a namespaced standing token is neither a thread seat nor a task");
}

{
  ok(isUnifiedSupervisorToken(standing), "the dispatch guard admits a bare window token");
  ok(!isUnifiedSupervisorToken(`unified:${standing}`), "the dispatch guard stays strict: a dispatch address takes the bare token, and eve adds the namespace");
}

{
  for (const token of [standing, explicit]) {
    const bare = redriveSeatOf(token);
    const namespaced = redriveSeatOf(`unified:${token}`);
    eq(bare, { token, domain: DOMAIN }, "the redrive seat of a bare token: the same token and its domain");
    eq(namespaced, bare, "🔴 the redrive seat of a namespaced token: the BARE token (its dispatch address) and the same domain");
  }
  eq(redriveSeatOf("not-a-window-token"), { token: "not-a-window-token", domain: undefined }, "NEGATIVE CONTROL: a token that is no window token gives no domain");
}

{
  const bare = auditLabels(explicit);
  ok(bare.workspace !== "unknown" && bare.surface !== undefined, "auditLabels labels a bare seat token");
  eq(auditLabels(`unified:${explicit}`), bare, "🔴 auditLabels labels the namespaced hook-frame token the same as the bare token");
  eq(auditLabels(undefined), { workspace: "unknown", surface: undefined }, "NEGATIVE CONTROL: no token gives the unknown label");
}

{
  const ctx = (continuationToken: string) => ({ channel: { continuationToken } }) as unknown as Parameters<typeof resolveOwnWindowToken>[0];
  eq(resolveOwnWindowToken(ctx(`unified:${explicit}`)), explicit, "the prompt road: resolveOwnWindowToken strips the namespace");
  eq(unifiedDomainFromToken(resolveOwnWindowToken(ctx(`unified:${explicit}`))), unifiedDomainFromToken(redriveSeatOf(`unified:${explicit}`).token), "🔴 the prompt road and the redrive road resolve the same domain");
}

const here = dirname(fileURLToPath(import.meta.url));

{
  const unifiedSrc = readFileSync(join(here, "../agent/channels/unified.ts"), "utf8");
  ok(/const \{ token: rawToken, domain \} = redriveSeatOf\(channel\.continuation\.token\);/.test(unifiedSrc), "🔴 the redrive resolves its seat through redriveSeatOf, not a strict parse of the channel token");
  ok(/buildRedriveReinject\(domain, rawToken, baseAttrs\)/.test(unifiedSrc), "…and hands that bare token and domain to the reinject");
}

{
  const eveDir = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
  const session = readFileSync(join(eveDir, "dist/src/channel/session.js"), "utf8");
  const frame = readFileSync(join(eveDir, "dist/src/definitions/frame.js"), "utf8");
  ok(session.includes("token:toChannelLocalContinuationToken("), "eve shape: a channel handler's continuation.token is the channel-local (bare) token");
  ok(frame.includes("continuationToken:e.get(ContinuationTokenKey)"), "eve shape: the hook, tool and instruction frame hands over the stored (namespaced) token");
  const { toChannelLocalContinuationToken } = (await import(pathToFileURL(join(eveDir, "dist/src/shared/continuation-token.js")).href)) as {
    toChannelLocalContinuationToken: (t: string) => string;
  };
  eq(toChannelLocalContinuationToken(`unified:${explicit}`), explicit, "eve shape: the channel-local token is the token with its namespace removed");
}

{
  const agentDir = join(here, "../agent");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== "generated") walk(p);
        continue;
      }
      if (!p.endsWith(".ts") || p.endsWith(join("channels", "window-key.ts"))) continue;
      const src = readFileSync(p, "utf8");
      if (/"unified:"\.length|startsWith\("unified:"\)|=\s*"unified:";/.test(src)) offenders.push(relative(agentDir, p));
    }
  };
  walk(agentDir);
  eq(offenders, [], "🔴 one resolver: no agent module outside channels/window-key.ts hand-rolls the `unified:` strip — use stripUnifiedSendPrefix or seatWindowKey");
}

console.log(`✓ unified-send-prefix: ${n} assertions passed (one resolver for the unified send prefix: domain, window, generation, redrive seat, audit labels, eve token shapes)`);
