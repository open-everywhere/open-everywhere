// proves: REPLY-11

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkStandDownGateSites,
  callsStandDownGate,
  STAND_DOWN_DIRECT_POSTS,
  STAND_DOWN_UNGATED,
  type StandDownGateFile,
} from "../agent/channels/stand-down-gate-manifest.js";

let n = 0;
const ok = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string): void => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
function toolFiles(): StandDownGateFile[] {
  const dirs = [join(repo, "packages", "core", "agent", "tools"), join(repo, "agent", "tools")];
  for (const p of readdirSync(join(repo, "packages", "providers"))) dirs.push(join(repo, "packages", "providers", p, "agent", "tools"));
  const out: StandDownGateFile[] = [];
  for (const d of dirs) {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const full = join(d, name);
      if (!name.endsWith(".ts") || name.endsWith(".d.ts") || !statSync(full).isFile()) continue;
      out.push({ file: relative(repo, full).split("\\").join("/"), source: readFileSync(full, "utf8") });
    }
  }
  return out;
}

const real = toolFiles();
ok(real.length > 50, `the scan reads the real tool tree (${real.length} files) — an empty scan would pass every case below vacuously`);
eq(checkStandDownGateSites(real), [], "the real tool tree is clean: every posting tool calls the gate or has a reviewed entry");

const WRITERS = ["halt", "complete_thread", "message_thread_seat", "open_pull_request", "reply", "edit_reply", "post_file", "react", "ask_room", "connector"];
for (const w of WRITERS) {
  const file = `packages/core/agent/tools/${w}.ts`;
  const src = real.find((f) => f.file === file);
  ok(src !== undefined && callsStandDownGate(src.source), `${w} calls the stand-down gate`);
  const stripped = real.map((f) =>
    f.file === file
      ? {
          file,
          source: f.source
            .replace(/refuseVerbIfStoodDown\(/g, "noGate(")
            .replace(/refuseTargetIfStopped\(/g, "noGate(")
            .replace(/withholdIfStoodDown\(/g, "noGate(")
            .replace(/boundStandDownState\(/g, "noGate(")
            .replace(/standDownState\(/g, "noGate("),
        }
      : f,
  );
  const problems = checkStandDownGateSites(stripped);
  ok(problems.length === 1 && problems[0]!.startsWith(file) && problems[0]!.includes("never calls the stand-down gate"), `🔴 ${w} with its gate removed is ONE lint problem that names the file (${JSON.stringify(problems)})`);
}

{
  const pr = real.find((f) => f.file === "packages/core/agent/tools/open_pull_request.ts")!.source;
  const direct = [...pr.matchAll(/\bpostSessionNote\(/g)].length;
  ok(direct === 2, `🔴 open_pull_request names postSessionNote( exactly twice — its definition and the one call inside postSessionNoteUnlessStoodDown — so the memo path cannot post past the gate (${direct})`);
  ok(/postSessionNoteUnlessStoodDown\(ctx as BindableContext/.test(pr), "…and the session-memo path calls postSessionNoteUnlessStoodDown");
}

{
  const fresh: StandDownGateFile = { file: "packages/core/agent/tools/new_poster.ts", source: "await postUnifiedReply(origin, text, {});" };
  const problems = checkStandDownGateSites([...real, fresh]);
  eq(problems.length, 1, "🔴 a NEW tool that posts and skips the gate is a lint problem");
  ok(problems[0]!.includes("new_poster.ts") && problems[0]!.includes("refuseVerbIfStoodDown"), "…that names the file and the call to add");
  eq(checkStandDownGateSites([...real, { ...fresh, source: `await refuseVerbIfStoodDown(c, "new_poster");\n${fresh.source}` }]), [], "negative control: the same tool with the gate is clean");
  const commented = { ...fresh, source: `// refuseVerbIfStoodDown(c, "new_poster") is not needed here\n${fresh.source}` };
  eq(checkStandDownGateSites([...real, commented]).length, 1, "🔴 a gate named only in a comment does not count");
}

const PINNED_DIRECT_POSTS = [
  "postUnifiedReply(",
  "postReply(",
  "postHostNotice",
  ".postText(",
  "postSurfaceText",
  "editSurfaceText(",
  "setSurfaceReaction(",
  ".dispatchReply(",
  ".dispatchUnified(",
  ".react(",
  ".postFiles(",
  "postFilesTo",
  "editPostedMessage(",
  ".editMessage(",
  "setReaction(",
  "chat.postMessage",
  "chat.update",
  "reactions.add",
];
eq(
  [...STAND_DOWN_DIRECT_POSTS].sort(),
  [...PINNED_DIRECT_POSTS].sort(),
  "🔴 the manifest's posting primitives are exactly the pinned list: a removal (or an addition) changes this test in the same commit",
);
for (const primitive of PINNED_DIRECT_POSTS) {
  const call = primitive.endsWith("(") ? `await x${primitive}a, b);` : `await x${primitive}(a, b);`;
  const f: StandDownGateFile = { file: "packages/core/agent/tools/new_surface_poster.ts", source: call };
  eq(checkStandDownGateSites([...real, f]).length, 1, `🔴 a new tool that posts through \`${primitive}\` and skips the gate is a lint problem`);
  eq(checkStandDownGateSites([...real, { ...f, source: `await refuseVerbIfStoodDown(c, "x");\n${call}` }]), [], `negative control: …the same \`${primitive}\` post behind the gate is clean`);
}

{
  const importOnly: StandDownGateFile = { file: "packages/core/agent/tools/set_state.ts", source: 'import { requestApproval } from "../approvals/flow.js";\nexport const x = 1;' };
  const withImportOnly = real.map((f) => (f.file === importOnly.file ? importOnly : f));
  const p = checkStandDownGateSites(withImportOnly);
  ok(p.length === 1 && p[0]!.includes("set_state.ts") && p[0]!.includes("no longer makes that kind of post"), `🔴 a tool that only IMPORTS requestApproval raises no card, so its approval-card entry is stale (${JSON.stringify(p)})`);
  const spaced: StandDownGateFile = { file: "packages/core/agent/tools/new_card_spaced.ts", source: "await requestApproval ({ org, kind });" };
  eq(checkStandDownGateSites([...real, spaced]).length, 1, "🔴 a card call written as `requestApproval (` is still an approval card");
}

{
  const card: StandDownGateFile = { file: "packages/core/agent/tools/new_card.ts", source: "await requestApproval({ org, kind });" };
  eq(checkStandDownGateSites([...real, card]).length, 1, "🔴 a new tool that raises an approval card with no entry is a lint problem");
  const gatedCard = { ...card, source: `await refuseVerbIfStoodDown(c, "x");\n${card.source}` };
  eq(checkStandDownGateSites([...real, gatedCard]).length, 1, "🔴 …and a gate elsewhere in the file does not excuse the card: requestApproval reads no gate");
}

{
  const stale = [...STAND_DOWN_UNGATED, { file: "packages/core/agent/tools/gone.ts", kind: "direct" as const, why: "by-design" as const, reason: "x" }];
  const problems = checkStandDownGateSites(real, stale);
  ok(problems.length === 1 && problems[0]!.includes("gone.ts") && problems[0]!.includes("stale"), "🔴 an entry for a file that is not in the scan is stale");
  const dm = real.map((f) => (f.file === "packages/core/agent/tools/confirm_link.ts" ? { ...f, source: `await refuseVerbIfStoodDown(c, "confirm_link");\n${f.source}` } : f));
  const p2 = checkStandDownGateSites(dm);
  ok(p2.length === 1 && p2[0]!.includes("confirm_link.ts") && p2[0]!.includes("stale"), "🔴 a by-design entry for a file that now calls the gate is stale");
  const empty = STAND_DOWN_UNGATED.map((u) => (u.file.endsWith("confirm_link.ts") ? { ...u, reason: " " } : u));
  ok(checkStandDownGateSites(real, empty).some((p) => p.includes("gives no reason")), "🔴 an entry with no reason is a problem");
}

ok(
  STAND_DOWN_UNGATED.filter((u) => u.why === "open").every((u) => u.kind === "approval-card" && u.reason.startsWith("OPE-2816")),
  "every open entry is an approval card, tracked by its own ticket",
);

console.log(`stand-down-gate-lint-test: ${n} assertions passed`);
