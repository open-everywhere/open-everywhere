export const WIN32_EXIT_ABORT_TICKET = "OPE-2287";

export const WIN32_EXIT_ABORT_ASSERTION = "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\\win\\async.c:94";

export const WIN32_EXIT_ABORT_LEGS = ["test:deploy", "test:egress-proxy-boot"] as const;

export type Win32ExitAbortLeg = (typeof WIN32_EXIT_ABORT_LEGS)[number];

export function win32ExitAbortSkipLine(leg: Win32ExitAbortLeg, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "win32") return null;
  return (
    `⏭ SKIP ${leg} on win32: the Node/libuv defect "${WIN32_EXIT_ABORT_ASSERTION}" aborts the spawned child ` +
    `at process.exit (${WIN32_EXIT_ABORT_TICKET}). This leg runs and gates on Linux.`
  );
}
