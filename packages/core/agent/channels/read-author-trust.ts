import { armedAuthorTrustTenants, authorRefutedByRegister } from "../identity/author-trust.js";
import type { RenderedLine } from "./channel-read.js";

export function distinctReadAuthorIds(lines: readonly RenderedLine[]): readonly string[] {
  const ids = new Set<string>();
  for (const line of lines) {
    if (line.bot === true) continue;
    const id = line.authorId;
    if (typeof id === "string" && id.length > 0) ids.add(id);
  }
  return [...ids];
}

export interface ReadAuthorProbe {
  readonly surfaceRefuted?: (authorId: string) => Promise<boolean | undefined>;
  readonly memberships?: (authorId: string) => Promise<readonly string[] | undefined>;
}

export async function readIngestsNonMember(
  lines: readonly RenderedLine[],
  tenantKey: string,
  probe: ReadAuthorProbe = {},
): Promise<boolean> {
  try {
    const ids = distinctReadAuthorIds(lines);
    if (ids.length === 0) return false;
    const armed = tenantKey.length > 0 && armedAuthorTrustTenants().includes(tenantKey);
    if (probe.surfaceRefuted === undefined && !armed) return false;
    const verdicts = await Promise.all(ids.map((id) => refutes(id, tenantKey, armed, probe)));
    return verdicts.includes(true);
  } catch {
    return false;
  }
}

async function refutes(authorId: string, tenantKey: string, armed: boolean, probe: ReadAuthorProbe): Promise<boolean> {
  if (probe.surfaceRefuted !== undefined && (await probe.surfaceRefuted(authorId)) === true) return true;
  if (!armed) return false;
  if (probe.memberships === undefined) {
    return authorRefutedByRegister({ tenantKey, authorId });
  }
  const memberships = await probe.memberships(authorId);
  if (memberships === undefined) return false;
  return authorRefutedByRegister({ tenantKey, authorId, memberships });
}
