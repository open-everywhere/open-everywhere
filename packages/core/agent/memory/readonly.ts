import type { MemorySilo } from "./silo.js";

export function isProjectedCache(silo: MemorySilo): boolean {
  return silo.provider === "notion";
}

export function readOnlyBanner(silo: MemorySilo): string {
  if (isProjectedCache(silo)) {
    const via = silo.skill ? "the `" + silo.skill + "` skill" : "the Notion tools";
    return (
      "<!-- READ-ONLY cache of Notion — editing these files is BLOCKED and will NOT save. " +
      "To update, use " + via + " (it writes to the source of truth); this cache then " +
      "refreshes from Notion. Do NOT edit these files. -->\n\n"
    );
  }
  return (
    "<!-- READ-ONLY baseline — editing these files is BLOCKED and will NOT save. " +
    "To record something for THIS channel, use the `remember` tool (it writes to this " +
    "channel's own writable memory), not these files. -->\n\n"
  );
}

export function hasReadOnlyBanner(md: string): boolean {
  return md.startsWith("<!-- READ-ONLY");
}

export function lockCommand(path: string): string {
  return `chmod -R a-w '${path}'`;
}

export function unlockCommand(path: string): string {
  return `chmod -R u+w '${path}'`;
}
