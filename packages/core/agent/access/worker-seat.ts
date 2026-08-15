export const WORKER_WITHHELD_TOOLS: ReadonlySet<string> = new Set<string>();

export function allowedOnWorkerSeat(name: string, withheld: ReadonlySet<string> = WORKER_WITHHELD_TOOLS): boolean {
  return !withheld.has(name);
}

export function restrictToolsetForWorkerSeat(toolset: Record<string, unknown>, withheld: ReadonlySet<string> = WORKER_WITHHELD_TOOLS): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(toolset)) {
    if (allowedOnWorkerSeat(name, withheld)) continue;
    delete toolset[name];
    removed.push(name);
  }
  return removed.sort();
}
