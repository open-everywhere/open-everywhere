export interface DeniedHostCount {
  readonly host: string;
  readonly count: number;
}

export interface DenialScan {
  readonly hosts: readonly DeniedHostCount[];
  readonly linesRead: number;
  readonly denials: number;
  readonly unparsed: number;
}

const RESULT_TAG = /^([A-Z][A-Z0-9_]*)\/(\d{3})$/u;

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+\.?$/u;
const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/u;

export function normaliseDenialHost(token: string): string | undefined {
  let v = token.trim();
  if (v.length === 0 || v === "-") return undefined;
  const scheme = v.indexOf("://");
  if (scheme >= 0) v = v.slice(scheme + 3);
  for (const cut of ["/", "?", "#"]) {
    const at = v.indexOf(cut);
    if (at >= 0) v = v.slice(0, at);
  }
  const at = v.lastIndexOf("@");
  if (at >= 0) v = v.slice(at + 1);
  if (v.startsWith("[")) {
    const close = v.indexOf("]");
    if (close >= 0) v = v.slice(0, close + 1);
  } else {
    const colon = v.lastIndexOf(":");
    if (colon >= 0) v = v.slice(0, colon);
  }
  v = v.toLowerCase();
  if (v.length === 0 || v.length > 253) return undefined;
  if (IPV6_LITERAL.test(v)) return v;
  return HOSTNAME.test(v) ? v : undefined;
}

export function isDenialTag(tag: string): boolean {
  return tag.includes("_DENIED");
}

export function reduceDenialLog(chunk: string): DenialScan {
  const counts = new Map<string, number>();
  let linesRead = 0;
  let denials = 0;
  let unparsed = 0;

  for (const raw of chunk.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    linesRead++;
    const tokens = line.split(/\s+/u);
    const tagAt = tokens.findIndex((t) => RESULT_TAG.test(t));
    if (tagAt < 0) continue;
    const tag = RESULT_TAG.exec(tokens[tagAt]!)![1]!;
    if (!isDenialTag(tag)) continue;
    denials++;
    let host: string | undefined;
    for (let i = tagAt + 1; i < tokens.length; i++) {
      host = normaliseDenialHost(tokens[i]!);
      if (host !== undefined) break;
    }
    if (host === undefined) {
      unparsed++;
      continue;
    }
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }

  const hosts = [...counts.entries()]
    .map(([host, count]) => ({ host, count }))
    .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));

  return { hosts, linesRead, denials, unparsed };
}

export interface TailPlan {
  readonly from: number;
  readonly to: number;
  readonly rotated: boolean;
}

export function planTailRead(size: number, lastOffset: number | undefined): TailPlan {
  if (lastOffset === undefined) return { from: size, to: size, rotated: false };
  if (size < lastOffset) return { from: 0, to: size, rotated: true };
  return { from: lastOffset, to: size, rotated: false };
}
