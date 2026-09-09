export interface OwnAccountGateFile {
  readonly file: string;
  readonly source: string;
}

export interface OwnAccountGateSite {
  readonly file: string;
  readonly line: number;
  readonly connector?: string;
}

export const OWN_ACCOUNT_GATE_CALL = "connectorActingIdentityForTurn";

export const OWN_ACCOUNT_GATE_MARKER = "own-account-gate:";

const MARKER_RE = /own-account-gate:\s*([A-Za-z0-9][A-Za-z0-9._-]*)/u;

function codeOnlyLines(source: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/gu, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, blank)
    .replace(/\/\*[\s\S]*$/u, blank)
    .replace(/\/\/[^\n]*/gu, blank)
    .replace(/`[\s\S]*?`/gu, blank)
    .replace(/"(?:[^"\\\n]|\\.)*"/gu, blank)
    .replace(/'(?:[^'\\\n]|\\.)*'/gu, blank);
}

function isGateCall(line: string): boolean {
  if (!line.includes(`${OWN_ACCOUNT_GATE_CALL}(`)) return false;
  return !/\bfunction\s+connectorActingIdentityForTurn\s*\(/u.test(line);
}

function markersAbove(lines: readonly string[], line: number): string[] {
  const found: string[] = [];
  for (let i = line - 2; i >= 0; i--) {
    const text = (lines[i] ?? "").trim();
    if (text === "") continue;
    const isComment = text.startsWith("//") || text.startsWith("*") || text.startsWith("/*");
    if (!isComment) break;
    const m = MARKER_RE.exec(text);
    if (m?.[1] !== undefined) found.push(m[1]);
  }
  return found;
}

export function findOwnAccountGateSites(files: readonly OwnAccountGateFile[]): OwnAccountGateSite[] {
  const sites: OwnAccountGateSite[] = [];
  for (const { file, source } of files) {
    const lines = source.split("\n");
    const code = codeOnlyLines(source).split("\n");
    for (let i = 0; i < code.length; i++) {
      if (!isGateCall(code[i] ?? "")) continue;
      const declared = markersAbove(lines, i + 1);
      if (declared.length === 0) sites.push({ file, line: i + 1 });
      else for (const connector of declared) sites.push({ connector, file, line: i + 1 });
    }
  }
  return sites;
}

export function checkOwnAccountGateSites(files: readonly OwnAccountGateFile[], connectors: readonly string[]): string[] {
  const sites = findOwnAccountGateSites(files);
  const problems: string[] = [];

  for (const site of sites) {
    if (site.connector !== undefined) continue;
    problems.push(
      `${site.file}:${site.line} — a \`${OWN_ACCOUNT_GATE_CALL}\` call with no \`${OWN_ACCOUNT_GATE_MARKER} <connector>\` ` +
        `marker in the comment block above it. Say which connector this gate covers: the connector is passed as a value ` +
        `and cannot be read from the source, so an unmarked gate covers nothing this lint can see.`,
    );
  }

  const gated = new Set(sites.map((s) => s.connector).filter((c): c is string => c !== undefined));
  const admitted = new Set(connectors);

  for (const connector of connectors) {
    if (gated.has(connector)) continue;
    problems.push(
      `\`${connector}\` is in CREDENTIAL_GRANT_ROLES (access/credential-grant.ts) but no call site consults the ` +
        `acting-identity gate for it. The own-account grammar recognises the vendor the moment it joins that list, so a ` +
        `requester asking to act with their own ${connector} account is stamped — and every read then runs on the ` +
        `deployment's own integration, which is the OPE-1525 defect. Add a \`${OWN_ACCOUNT_GATE_CALL}\` call at the line ` +
        `that resolves the ${connector} credential, and mark it \`${OWN_ACCOUNT_GATE_MARKER} ${connector}\`.`,
    );
  }

  for (const connector of [...gated].sort()) {
    if (admitted.has(connector)) continue;
    problems.push(
      `a gate marked \`${OWN_ACCOUNT_GATE_MARKER} ${connector}\` covers a connector CREDENTIAL_GRANT_ROLES does not admit — ` +
        `a stale join. The gate still recognises an ask for ${connector}, but no grant can be minted for it, so the gate ` +
        `can only ever REFUSE: a member naming their own ${connector} account is turned away with a route this deployment ` +
        `cannot open. Either add ${connector} to the reviewed list, or delete the gate call together with its marker.`,
    );
  }

  return problems;
}
