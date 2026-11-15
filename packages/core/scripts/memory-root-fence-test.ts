// proves: MEM-25

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MEMORY_ROOT_DIR,
  lockMemoryRoot,
  memoryRootLockCommand,
  memoryRootUnlockCommand,
  withMemoryRootWritable,
} from "../agent/memory/root-fence.js";
import { lockCommand } from "../agent/memory/readonly.js";
import { posixWriteBitsAbsentReason, withoutDacOverride, writeBitsBite } from "../../../scripts/dac-fence.js";
import { finishedRun, type ChildResult } from "../../../scripts/npm-command.js";

let n = 0;
const ok = (cond: boolean, label: string) => {
  assert.ok(cond, label);
  n++;
};

ok(memoryRootLockCommand() === `chmod a-w '${MEMORY_ROOT_DIR}'`, "lock command is a NON-recursive chmod of the memory root");
ok(!memoryRootLockCommand().includes("-R"), "the root lock is never recursive");
ok(lockCommand(MEMORY_ROOT_DIR).includes("-R"), "…and readonly.ts's tier lock still IS recursive — the two are not interchangeable");
ok(memoryRootUnlockCommand() === `chmod u+w '${MEMORY_ROOT_DIR}'`, "unlock command restores owner write on the root only");

const MEASURE_ONLY_FLAG = "--measure-only";
const MEASURED_PREFIX = "MEASURED assertions=";
const selfPath = fileURLToPath(import.meta.url);
const tsxBin = join(dirname(selfPath), "..", "..", "..", "node_modules", ".bin", "tsx");

async function runMeasurement(): Promise<number> {
  const before = n;
  const base = mkdtempSync(join(tmpdir(), "oe-root-fence-"));
  try {
    const root = join(base, MEMORY_ROOT_DIR);
    const ownedSilo = join(root, "owned-silo");
    mkdirSync(ownedSilo, { recursive: true });
    writeFileSync(join(ownedSilo, "MEMORY.md"), "# owned\n");
    writeFileSync(join(root, "MEMORY.md"), "# index v1\n");

    chmodSync(root, 0o555);

    const justBashWrite = async (path: string, content: string): Promise<void> => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    };
    const threw = async (fn: () => Promise<unknown>): Promise<NodeJS.ErrnoException | null> => {
      try {
        await fn();
        return null;
      } catch (err) {
        return err as NodeJS.ErrnoException;
      }
    };

    const denied = await threw(() => justBashWrite(join(root, "unowned-silo", "stolen.md"), "x"));
    ok(denied !== null && denied.code === "EACCES", "just-bash: creating a NEW silo directory under the fenced root fails with EACCES");
    ok(!existsSync(join(root, "unowned-silo")), "…and the directory really is absent afterwards");

    ok((await threw(() => justBashWrite(join(ownedSilo, "notes.md"), "kept"))) === null, "just-bash: a NEW file inside an owned silo still writes");
    ok(readFileSync(join(ownedSilo, "notes.md"), "utf-8") === "kept", "…with the expected bytes");
    ok((await threw(() => justBashWrite(join(ownedSilo, "MEMORY.md"), "# owned v2\n"))) === null, "just-bash: an EXISTING file inside an owned silo still rewrites");

    ok((await threw(() => justBashWrite(join(root, "MEMORY.md"), "# index v2\n"))) === null, "just-bash: rewriting an EXISTING file at the fenced root SUCCEEDS — truncate-in-place, not unlink-and-create");
    ok(readFileSync(join(root, "MEMORY.md"), "utf-8") === "# index v2\n", "…and the new bytes are what landed");

    const newAtRoot = await threw(() => justBashWrite(join(root, "rogue.md"), "x"));
    ok(newAtRoot !== null && newAtRoot.code === "EACCES", "just-bash: creating a NEW file directly at the fenced root fails with EACCES");

    const dockerInput = join(base, "docker-input");
    const dockerWrite = (path: string, content: string): number => {
      writeFileSync(dockerInput, content);
      const stdin = openSync(dockerInput, "r");
      try {
        execFileSync("/bin/sh", ["-c", `mkdir -p '${dirname(path)}' && cat > '${path}'`], { stdio: [stdin, "pipe", "pipe"] });
        return 0;
      } catch (err) {
        return finishedRun(err as ChildResult, "the docker-backend write").status;
      } finally {
        closeSync(stdin);
      }
    };
    ok(dockerWrite(join(root, "unowned-docker", "stolen.md"), "x".repeat(1 << 20)) !== 0, "docker: creating a NEW silo directory under the fenced root fails");
    ok(!existsSync(join(root, "unowned-docker")), "…and the directory really is absent afterwards");
    ok(dockerWrite(join(ownedSilo, "docker-note.md"), "kept") === 0, "docker: a NEW file inside an owned silo still writes");
    ok(dockerWrite(join(root, "MEMORY.md"), "# index v3\n") === 0, "docker: rewriting an EXISTING file at the fenced root SUCCEEDS — truncate-in-place");
    ok(readFileSync(join(root, "MEMORY.md"), "utf-8") === "# index v3\n", "…and the new bytes are what landed");

    execFileSync("/bin/sh", ["-c", memoryRootUnlockCommand()], { cwd: base });
    ok(dockerWrite(join(root, "surface", "STATUS.md"), "status") === 0, "an UNLOCKED root takes a new tier directory — the update_status / re-sync path");
    execFileSync("/bin/sh", ["-c", memoryRootLockCommand()], { cwd: base });
    ok(dockerWrite(join(root, "unowned-again", "x.md"), "x") !== 0, "…and re-locking closes it again");
  } finally {
    try {
      execFileSync("/bin/sh", ["-c", `chmod -R u+w '${base}'`]);
    } catch {
    }
    rmSync(base, { recursive: true, force: true });
  }
  return n - before;
}

function runMeasurementFenced(): number {
  const { cmd, args } = withoutDacOverride(tsxBin, [selfPath, MEASURE_ONLY_FLAG]);
  const child = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (child.error !== undefined) throw child.error;
  const out = child.stdout ?? "";
  process.stdout.write(
    out
      .split("\n")
      .filter((line) => !line.startsWith(MEASURED_PREFIX))
      .join("\n"),
  );
  assert.equal(child.status, 0, `§1 measured in a fenced child process (exit ${String(child.status)})`);
  const measured = new RegExp(`^${MEASURED_PREFIX}(\\d+)$`, "mu").exec(out);
  assert.ok(measured !== null, "the fenced child reported its assertion count — without it a silent early return would read as a pass");
  const made = Number(measured[1]);
  console.log(`🔒 memory-root-fence: §1 ran in a child process with CAP_DAC_OVERRIDE dropped — ${made} assertion(s).`);
  return made;
}

if (process.argv.includes(MEASURE_ONLY_FLAG)) {
  const made = await runMeasurement();
  console.log(`${MEASURED_PREFIX}${made}`);
  process.exit(0);
}

const noWriteBits = posixWriteBitsAbsentReason();
if (noWriteBits !== null) {
  console.log(`⏭ memory-root-fence: §1 SKIPPED on ${process.platform}, NOT proven here — ${noWriteBits}.`);
} else if (writeBitsBite()) {
  await runMeasurement();
} else {
  n += runMeasurementFenced();
}

class RecordingSandbox {
  readonly commands: string[] = [];
  failOn: RegExp | null = null;
  async run({ command }: { command: string }): Promise<{ stdout: string }> {
    this.commands.push(command);
    if (this.failOn?.test(command)) throw new Error(`simulated sandbox failure for ${command}`);
    return { stdout: "" };
  }
}

{
  const s = new RecordingSandbox();
  const seen: string[] = [];
  const out = await withMemoryRootWritable(s, async () => {
    seen.push(...s.commands);
    return "done";
  });
  ok(out === "done", "withMemoryRootWritable returns the work's own value");
  ok(seen.length === 1 && seen[0] === memoryRootUnlockCommand(), "the root is unlocked BEFORE the work runs");
  ok(s.commands.length === 2 && s.commands[1] === memoryRootLockCommand(), "…and re-locked after it");
}

{
  const s = new RecordingSandbox();
  let caught: unknown = null;
  try {
    await withMemoryRootWritable(s, async () => {
      throw new Error("transport blew up mid-write");
    });
  } catch (err) {
    caught = err;
  }
  ok(caught instanceof Error && caught.message.includes("transport blew up"), "the work's own error still propagates");
  ok(s.commands.length === 2 && s.commands[1] === memoryRootLockCommand(), "…and the root is re-locked anyway (the `finally`)");
}

{
  const s = new RecordingSandbox();
  s.failOn = /u\+w/;
  let ran = false;
  const out = await withMemoryRootWritable(s, async () => {
    ran = true;
    return 7;
  });
  ok(out === 7 && ran, "a failed unlock never blocks the host's own write");
  ok(s.commands.length === 1, "…and no lock is issued for a root that was never unlocked");
  ok(!s.commands.some((c) => c === memoryRootLockCommand()), "…checked by command, not only by count");
}

{
  const s = new RecordingSandbox();
  ok((await lockMemoryRoot(s)) === true, "lockMemoryRoot reports success");
  ok(s.commands.length === 1 && s.commands[0] === memoryRootLockCommand(), "…having run exactly the lock command");
  s.failOn = /a-w/;
  ok((await lockMemoryRoot(s)) === false, "lockMemoryRoot reports failure rather than throwing — the caller degrades, the session survives");
}

console.log(`✅ memory-root-fence: ${n} assertions passed`);
