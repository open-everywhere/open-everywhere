export const MEMORY_ROOT_DIR = "memory";

export function memoryRootLockCommand(): string {
  return `chmod a-w '${MEMORY_ROOT_DIR}'`;
}

export function memoryRootUnlockCommand(): string {
  return `chmod u+w '${MEMORY_ROOT_DIR}'`;
}

export interface RootFenceSandbox {
  run(options: { command: string }): PromiseLike<unknown>;
}

export async function lockMemoryRoot(sandbox: RootFenceSandbox): Promise<boolean> {
  try {
    await sandbox.run({ command: memoryRootLockCommand() });
    return true;
  } catch {
    return false;
  }
}

export async function withMemoryRootWritable<T>(sandbox: RootFenceSandbox, fn: () => Promise<T>): Promise<T> {
  let unlocked = false;
  try {
    await sandbox.run({ command: memoryRootUnlockCommand() });
    unlocked = true;
  } catch {
  }
  try {
    return await fn();
  } finally {
    if (unlocked) await lockMemoryRoot(sandbox);
  }
}
