import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

console.log("slack-web-api seam:");

const PKG_ROOT = process.cwd();
const SEAM = join(PKG_ROOT, "agent/channels/slack-web-api.ts");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

{
  const evePrimitiveImport = /import\s*\{[^}]*\bcallSlackApi\b[^}]*\}\s*from\s*"eve\/channels\/slack"/;
  const offenders: string[] = [];
  for (const file of tsFiles(join(PKG_ROOT, "agent"))) {
    if (file === SEAM) continue;
    if (evePrimitiveImport.test(readFileSync(file, "utf8"))) offenders.push(relative(PKG_ROOT, file));
  }
  ok(
    offenders.length === 0,
    `no bypass: no file outside slack-web-api.ts may import eve's callSlackApi — found ${offenders.length}: ${offenders.join(", ")}`,
  );
}

{
  const KNOWN_UNCOVERED: ReadonlyArray<{ file: string; why: string }> = [
    { file: "agent/channels/slack-context.ts", why: "ctx.slack.request — auth.test + conversations.history on the bound session" },
    { file: "agent/channels/slack-input-response.ts", why: "ctx.thread.postEphemeral — eve's binding owns the transport" },
    { file: "agent/channels/slack.ts", why: "ctx.slack.request — conversations.info / users.info / pins.list; plus ctx.thread.post for the intro and unmapped-wake notices" },
  ];
  const bindingCall = /\.(slack\.request|thread\.post[A-Za-z]*)\s*\(/;

  const found: string[] = [];
  for (const file of tsFiles(join(PKG_ROOT, "agent"))) {
    if (file === SEAM) continue;
    if (bindingCall.test(readFileSync(file, "utf8"))) found.push(relative(PKG_ROOT, file));
  }
  const expected = KNOWN_UNCOVERED.map((e) => e.file).sort();
  const unexpected = found.filter((f) => !expected.includes(f)).sort();
  const vanished = expected.filter((f) => !found.includes(f));

  ok(
    unexpected.length === 0,
    `no NEW bypass: a Slack call through eve's binding appeared outside the known-uncovered list — ${unexpected.join(", ")}. ` +
      `Either route it through slack-web-api.ts, or add it to KNOWN_UNCOVERED and to the audit table in docs/extending/provider-rate-limits.md.`,
  );
  ok(
    vanished.length === 0,
    `the known-uncovered list is stale: ${vanished.join(", ")} no longer makes a binding call, so the docs overstate the gap — shorten the list.`,
  );
}

{
  const scanned = tsFiles(join(PKG_ROOT, "agent"));
  ok(scanned.length > 20, `scan sanity: the agent tree yields a plausible file count (got ${scanned.length})`);
  const seamUsers = scanned.filter((f) => f !== SEAM && readFileSync(f, "utf8").includes("callSlackWebApi("));
  ok(seamUsers.length >= 4, `scan sanity: the seam still has its 4 migrated call sites (got ${seamUsers.length})`);
}

{
  const seamSrc = readFileSync(SEAM, "utf8");
  ok(seamSrc.includes("withRetryAfter"), "the seam still routes its request through withRetryAfter — the backoff has not been removed");
  ok(
    seamSrc.includes("@open-everywhere/core/agent/adapter-api.js"),
    "the seam still imports the shared backoff from core's adapter-api barrel, rather than growing a second private copy",
  );
}

console.log(`✓ slack-web-api seam: ${n} assertions passed (no new eve-binding bypass, known-uncovered inventory exact, scan sanity, backoff still wired)`);
