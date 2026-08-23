import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OE_MEMORY_DIR = mkdtempSync(join(tmpdir(), "oe-update-status-"));

import assert from "node:assert/strict";
import updateStatusTool from "../agent/tools/update_status.js";
import { execTool } from "./_tool-exec.js";
import { gitProvider, registerProvider, resetProvider, type MemoryProvider } from "../agent/memory/provider.js";
import { SURFACE, tierId, type MemoryFiles, type Tier } from "../agent/memory/store.js";
import { resolvePartition, type Partition } from "../agent/memory/partition.js";
import { tierSandboxDir } from "../agent/memory/sandbox-sync.js";
import { statusItemLine, statusSeed, upsertStatusItem } from "../agent/status/status.js";
import type { BindableContext } from "../agent/identity/binding.js";

import { registerSlackFixtureMapper } from "./_slack-test-stubs.js";
registerSlackFixtureMapper();

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};
const eq = (a: unknown, b: unknown, label: string) => {
  assert.deepStrictEqual(a, b, label);
  n++;
};

const SURFACE_DIR = tierSandboxDir(SURFACE);

{
  const p: Partition = {
    org: "acme",
    platform: "slack",
    workspace: "T0",
    surface: "C0",
    workspaceKey: "slack/T0",
    surfaceKey: "slack/T0/C0",
    domainKey: "slack/T0/C0",
    key: "slack/T0/C0",
  };
  await gitProvider.writeTier(p, SURFACE, { "MEMORY.md": "# kept\n", "people.md": "- ada\n" }, "seed");
  await gitProvider.writeTier(p, SURFACE, { "STATUS.md": "# status v1\n" }, "status");
  const after = await gitProvider.readTier(p, SURFACE);
  eq(after["MEMORY.md"], "# kept\n", "git provider: a one-file writeTier PRESERVES an omitted file (upsert-only)");
  eq(after["people.md"], "- ada\n", "git provider: …every omitted file, not just the first");
  eq(after["STATUS.md"], "# status v1\n", "git provider: …and the named file really landed (the negative control for the two above)");
  await gitProvider.writeTier(p, SURFACE, { "MEMORY.md": "# replaced\n" }, "replace");
  eq((await gitProvider.readTier(p, SURFACE))["MEMORY.md"], "# replaced\n", "git provider: a NAMED file is replaced — the write is not a no-op");
}

const durable = new Map<string, MemoryFiles>();
const writeTierCalls: { tier: string; files: MemoryFiles }[] = [];

const statusProvider: MemoryProvider = {
  id: "fake-status-store",
  async readTier(_p: Partition, tier: Tier) {
    return { ...(durable.get(tierId(tier)) ?? {}) };
  },
  async ensureTier(_p: Partition, tier: Tier) {
    return { ...(durable.get(tierId(tier)) ?? {}) };
  },
  async writeTier(_p: Partition, tier: Tier, files: MemoryFiles) {
    writeTierCalls.push({ tier: tierId(tier), files: { ...files } });
    durable.set(tierId(tier), { ...(durable.get(tierId(tier)) ?? {}), ...files });
    return "v1";
  },
  async deleteTier() {},
};
registerProvider(statusProvider);
process.env.OE_MEMORY_PROVIDER = statusProvider.id;
resetProvider();

class FakeSandbox {
  readonly files = new Map<string, string>();
  readonly commands: string[] = [];
  async writeTextFile({ path, content }: { path: string; content: string }): Promise<void> {
    this.commands.push(`write:${path}`);
    this.files.set(path, content);
  }
  async readTextFile({ path }: { path: string }): Promise<string | null> {
    return this.files.has(path) ? (this.files.get(path) as string) : null;
  }
  async run({ command }: { command: string }): Promise<{ stdout: string }> {
    this.commands.push(command);
    const list = command.match(/^cd (\S+) 2>\/dev\/null && find \. -type f/);
    if (list) {
      const dir = list[1];
      const rels = [...this.files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1));
      return { stdout: rels.join("\n") };
    }
    return { stdout: "" };
  }
}

const SLACK_ATTRS: Record<string, string> = {
  team_id: "T1",
  channel_id: "C1",
  channel_type: "channel",
  is_private: "false",
  is_ext_shared: "false",
  trust_checked: "true",
  user_id: "U7",
};

function makeCtx(sessionId: string, sandbox: FakeSandbox): BindableContext {
  return {
    agent: { name: "test" },
    channel: { kind: "slack" },
    getSandbox: async () => sandbox,
    session: { id: sessionId, auth: { current: { principalId: "U7", principalType: "slack-user", attributes: { ...SLACK_ATTRS } } } },
  } as unknown as BindableContext;
}

const runStatus = execTool(updateStatusTool);
const surfaceTierId = tierId(SURFACE);
const stored = (): MemoryFiles => ({ ...(durable.get(surfaceTierId) ?? {}) });

{
  const sandbox = new FakeSandbox();
  sandbox.files.set(`${SURFACE_DIR}/stolen.md`, "exfiltrated by a shell redirect");
  sandbox.files.set(`${SURFACE_DIR}/notes/deep.md`, "and one a level down");

  const out = await runStatus({ state: "working", summary: "S1-first" }, makeCtx("sess-1", sandbox) as never);
  eq(out.updated, true, "the tool reports the update");

  const files = stored();
  eq(Object.keys(files).sort(), ["STATUS.md"], "ONLY STATUS.md reached the durable surface tier — the shell-written files did not");
  ok(files["stolen.md"] === undefined, "the shell-written file is absent from the durable tier");
  ok(files["notes/deep.md"] === undefined, "…and so is the nested one");
  ok((files["STATUS.md"] ?? "").includes("S1-first"), "the tool's own status line DID reach the durable tier");
  for (const call of writeTierCalls) eq(Object.keys(call.files), ["STATUS.md"], "every writeTier call names exactly one file");
}

{
  durable.set(surfaceTierId, {
    "MEMORY.md": "# Personal memory\n- ada prefers async updates\n",
    "people.md": "- ada — payments\n",
  });
  const sandbox = new FakeSandbox();
  await runStatus({ state: "done", summary: "S2-dm" }, makeCtx("sess-dm", sandbox) as never);

  const files = stored();
  eq(files["MEMORY.md"], "# Personal memory\n- ada prefers async updates\n", "a DM's durable MEMORY.md survives an update_status call");
  eq(files["people.md"], "- ada — payments\n", "…and so does every other durable surface file");
  ok((files["STATUS.md"] ?? "").includes("S2-dm"), "…while the status line still lands (the negative control)");
}

{
  const otherLine = statusItemLine("sess-other", "working", "S3-other-thread", "2026-08-23 09:00Z");
  const board = upsertStatusItem(statusSeed("slack/T1/C1"), "sess-other", otherLine);
  durable.set(surfaceTierId, { "STATUS.md": board });

  const sandbox = new FakeSandbox();
  await runStatus({ state: "blocked", summary: "S3-mine" }, makeCtx("sess-mine", sandbox) as never);

  const body = stored()["STATUS.md"] ?? "";
  ok(body.includes("S3-other-thread"), "another thread's line survives a status call from a session whose sandbox has no STATUS.md");
  ok(body.includes("S3-mine"), "…and this session's line is added alongside it");
}

{
  durable.delete(surfaceTierId);
  const sandbox = new FakeSandbox();
  await runStatus({ state: "needs_input", summary: "S4-sandbox" }, makeCtx("sess-4", sandbox) as never);

  const live = sandbox.files.get(`${SURFACE_DIR}/STATUS.md`) ?? "";
  ok(live.includes("S4-sandbox"), "the live sandbox copy is still written");
  const unlockAt = sandbox.commands.indexOf("chmod u+w 'memory'");
  const writeAt = sandbox.commands.indexOf(`write:${SURFACE_DIR}/STATUS.md`);
  const lockAt = sandbox.commands.indexOf("chmod a-w 'memory'");
  ok(unlockAt >= 0 && writeAt >= 0 && lockAt >= 0, "the unlock, the write and the re-lock all ran");
  ok(unlockAt < writeAt, "the root unlock runs BEFORE the sandbox write");
  ok(writeAt < lockAt, "the re-lock runs AFTER the sandbox write");
  ok(!sandbox.commands.some((c) => c.includes("find . -type f")), "the tool no longer LISTS the sandbox surface directory at all");
}

console.log(`✅ update_status durable-write tests passed (${n} assertions)`);
