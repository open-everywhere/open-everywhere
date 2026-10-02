export type BootNotice = () => Promise<void>;

const NOTICES = new Map<string, BootNotice>();

export function registerBootNotice(name: string, notice: BootNotice): void {
  NOTICES.set(name, notice);
}

export function resetBootNotices(): void {
  NOTICES.clear();
}

export function registeredBootNoticeNames(): readonly string[] {
  return [...NOTICES.keys()];
}

export async function runBootNotices(): Promise<void> {
  for (const [name, notice] of NOTICES) {
    try {
      await notice();
    } catch (err) {
      console.warn(`[open-everywhere:boot] notice "${name}" failed: ${String(err instanceof Error ? err.message : err)}`);
    }
  }
}
