const recordedSandboxNames = new Map<string, string>();

export function recordCreatedSandbox(sessionId: string, name: string): void {
  if (sessionId.length === 0 || name.length === 0) return;
  recordedSandboxNames.set(sessionId, name);
}

export function getRecordedSandboxName(sessionId: string): string | undefined {
  return recordedSandboxNames.get(sessionId);
}

export function clearRecordedSandboxesForTest(): void {
  recordedSandboxNames.clear();
}
