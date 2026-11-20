import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const workflowCore = join(eveRoot, "dist/src/compiled/@workflow/core");
const read = (p: string): string => readFileSync(p, "utf8");

const privateJs = read(join(workflowCore, "private.js"));
// eve 1.x moves the events-consumer construction out of runtime.js into a bundled chunk. The wiring
// module is the one that passes the `isDeliveryIdle` option: runtime.js when it does, else that chunk.
const runtimeJs = ((): string => {
  const entry = read(join(workflowCore, "runtime.js"));
  if (entry.includes("isDeliveryIdle:")) return entry;
  const chunks = join(eveRoot, "dist/src/compiled/_chunks/workflow");
  const carriers = readdirSync(chunks)
    .filter((f) => f.endsWith(".js"))
    .map((f) => read(join(chunks, f)))
    .filter((text) => text.includes("isDeliveryIdle:()=>"));
  assert.equal(carriers.length, 1, "exactly one compiled workflow module wires the events consumer's isDeliveryIdle option");
  return carriers[0]!;
})();
const consumerDts = read(join(workflowCore, "events-consumer.d.ts"));

const KNOB = "WORKFLOW_DEFERRED_CHECK_DELAY_MS";

function gitGrepFiles(cwd: string, needle: string): string[] {
  try {
    return execFileSync("git", ["grep", "-l", "--", needle], { cwd, encoding: "utf8" })
      .split("\n")
      .filter((l) => l.length > 0);
  } catch (err) {
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

const importClause = (moduleText: string, source: string): string =>
  new RegExp(`import\\{([^}]*)\\}from"[^"]*${source}[^"]*"`).exec(moduleText)?.[1] ?? "";

const sourceNameOf = (clause: string, local: string): string | undefined => {
  const renamed = new RegExp(`(?:^|,)\\s*(\\w+)\\s+as\\s+${local}\\s*(?:,|$)`).exec(clause);
  if (renamed) return renamed[1];
  return new RegExp(`(?:^|,)\\s*${local}\\s*(?:,|$)`).test(clause) ? local : undefined;
};

const localNameOf = (clause: string, sourceName: string): string | undefined => {
  const renamed = new RegExp(`(?:^|,)\\s*${sourceName}\\s+as\\s+(\\w+)\\s*(?:,|$)`).exec(clause);
  if (renamed) return renamed[1];
  return new RegExp(`(?:^|,)\\s*${sourceName}\\s*(?:,|$)`).test(clause) ? sourceName : undefined;
};

const chunkExportName = (shimText: string, publicName: string): string | undefined => {
  const shimLocal = new RegExp(`(?:export\\{|,)\\s*(\\w+)\\s+as\\s+${publicName}\\s*[,}]`).exec(shimText)?.[1];
  if (shimLocal === undefined) return undefined;
  const viaChunk = sourceNameOf(importClause(shimText, "private"), shimLocal);
  if (viaChunk !== undefined) return viaChunk;
  // eve 1.x: the shim is one `export{i as isDeliveryIdle,…}from"…/private-<hash>.js"` statement, so
  // the name on the left of `as` is the chunk's own export name.
  if (new RegExp(`^export\\{[^}]*\\b${shimLocal}\\s+as\\s+${publicName}\\b[^}]*\\}from"[^"]*private[^"]*"`).test(shimText.trim())) return shimLocal;
  return declaresLocal(shimText, shimLocal) ? publicName : undefined;
};

const declaresLocal = (moduleText: string, local: string): boolean =>
  new RegExp(`(?:function\\s+${local}\\s*\\(|(?:const|let|var)\\s+(?:[^;]*?,\\s*)?${local}\\s*=)`).test(moduleText);

const wiresRealDeliveryIdle = (runtimeText: string, local: string): boolean => {
  const holder = /isDeliveryIdle:\(\)=>(\w+)\.current\(\)/.exec(runtimeText)?.[1];
  if (holder === undefined) return false;
  return new RegExp(`\\b${holder}\\.current=\\(\\)=>${local}\\(`).test(runtimeText);
};

const methodBody = (text: string, name: string): string | undefined => {
  const m = new RegExp(`${name}\\(\\w*(?:,\\w+)*\\)\\{`).exec(text);
  if (m === null) return undefined;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
  }
  return undefined;
};

const checkWaitsForIdle = (consumerText: string): boolean => {
  const body = methodBody(consumerText, "scheduleUnconsumedCheck");
  return body !== undefined && body.includes("whenDeliveryIdle(");
};

const consumerJs = ((): string => {
  const chunks = join(eveRoot, "dist/src/compiled/_chunks/workflow");
  for (const f of readdirSync(chunks)) {
    if (!f.endsWith(".js")) continue;
    const text = read(join(chunks, f));
    if (text.includes(KNOB) && text.includes("scheduleUnconsumedCheck(")) return text;
  }
  return assert.fail(`no compiled workflow chunk carries both ${KNOB} and scheduleUnconsumedCheck`);
})();

const idleChunkName = chunkExportName(privateJs, "isDeliveryIdle");
ok(idleChunkName !== undefined, "alias: the private chunk still exports `isDeliveryIdle`");
ok(
  chunkExportName(privateJs, "hasParkedCommittedDelivery") !== undefined,
  "alias: the private chunk still exports `hasParkedCommittedDelivery`, the termination rule the idle wait rests on",
);

ok(
  chunkExportName("export{w as isDeliveryIdle};", "isDeliveryIdle") === undefined,
  "alias control: an exported local that the module neither imports nor declares resolves nothing",
);
ok(
  chunkExportName("function w(){return!0}export{w as isDeliveryIdle};", "isDeliveryIdle") === "isDeliveryIdle",
  "alias control: a local the module declares itself resolves to the PUBLIC name its consumers import",
);

const idleLocal = idleChunkName === undefined ? undefined : localNameOf(importClause(runtimeJs, "private"), idleChunkName);
ok(idleLocal !== undefined, "alias: the installed runtime imports the exported `isDeliveryIdle` from the private chunk");
assert.ok(idleLocal !== undefined);

ok(
  runtimeJs.includes("isDeliveryIdle:"),
  "wiring: the installed runtime passes an `isDeliveryIdle` option to the events consumer",
);
ok(
  wiresRealDeliveryIdle(runtimeJs, idleLocal),
  "wiring: that option resolves to the real predicate, not the always-idle placeholder — the gate is armed on the replay path",
);

ok(
  checkWaitsForIdle(consumerJs),
  "ordering: the unconsumed-event check waits for delivery-idle before it arms the deferred-delay timer",
);
ok(
  consumerDts.includes("isDeliveryIdle: () => boolean;"),
  "ordering: `isDeliveryIdle` is still a REQUIRED consumer option — an optional one would let a construction site opt a replay path back out silently",
);

const PLACEHOLDER_ONLY = `let H={current:()=>!0};const C=new EC(n,{onUnconsumedEvent:e=>h(e),isDeliveryIdle:()=>H.current()});`;
ok(
  !wiresRealDeliveryIdle(PLACEHOLDER_ONLY, idleLocal),
  "pre-gate: a runtime that leaves the always-idle placeholder installed reads as ungated",
);
ok(
  !wiresRealDeliveryIdle(`const C=new EC(n,{onUnconsumedEvent:e=>h(e)});`, idleLocal),
  "pre-gate: a runtime that passes no `isDeliveryIdle` option at all reads as ungated",
);
ok(
  !wiresRealDeliveryIdle(`${PLACEHOLDER_ONLY}H.current=()=>someOtherPredicate(E);`, idleLocal),
  "pre-gate: a holder reassigned to a predicate other than the imported one reads as ungated",
);
ok(
  wiresRealDeliveryIdle(`${PLACEHOLDER_ONLY}H.current=()=>${idleLocal}(E);`, idleLocal),
  "pre-gate: the same analyser accepts a holder reassigned to the imported predicate",
);
ok(
  !checkWaitsForIdle(
    `scheduleUnconsumedCheck(e,t){this.pendingUnconsumedCheck=this.getPromiseQueue().then(()=>{this.pendingUnconsumedTimeout=setTimeout(()=>{this.resolveUnconsumedEvent(e,t)},Bs())})}`,
  ),
  "pre-gate: a check that arms the deferred timer straight off the promise queue reads as ungated",
);
ok(
  !checkWaitsForIdle(`whenDeliveryIdle(e,t){/* present, but nothing schedules through it */}`),
  "pre-gate: a `whenDeliveryIdle` that exists but does not gate the scheduling body reads as ungated",
);

const isProse = (path: string): boolean =>
  path.startsWith("docs/") || path.endsWith(".md") || path.includes("/docs/generated/") || path.endsWith("eve-delivery-gate-test.ts");
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: eveRoot, encoding: "utf8" }).trim();
const setters = gitGrepFiles(repoRoot, KNOB).filter((p) => !isProse(p));
ok(setters.length === 0, `unset: no shipped file sets ${KNOB} (found: ${setters.join(", ")})`);

console.log(`\n✓ eve-delivery-gate: ${n} assertions passed (alias, wiring, ordering, pre-gate, unset)\n`);
