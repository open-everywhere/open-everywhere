import { isSafeSkillName } from "./repo-skills.js";

export function authExtraHeader(token: string): string {
  const b64 = Buffer.from(`x-access-token:${token}`, "utf-8").toString("base64");
  return `AUTHORIZATION: basic ${b64}`;
}

export function cloneArgs(repo: string, token: string, dir: string, host = "github.com"): string[] {
  return ["-c", `http.extraheader=${authExtraHeader(token)}`, "clone", "--", `https://${host}/${repo}.git`, dir];
}

export function fetchArgs(token: string, remote = "origin"): string[] {
  return ["-c", `http.extraheader=${authExtraHeader(token)}`, "fetch", remote];
}

export function pushArgs(token: string, branch: string, remote = "origin"): string[] {
  return ["-c", `http.extraheader=${authExtraHeader(token)}`, "push", remote, branch];
}

export function botCommitter(appSlug: string, botUserId: string): { name: string; email: string } {
  const name = `${appSlug}[bot]`;
  return { name, email: `${botUserId}+${name}@users.noreply.github.com` };
}

export function identityArgs(appSlug: string, botUserId: string): string[] {
  const c = botCommitter(appSlug, botUserId);
  return ["-c", `user.name=${c.name}`, "-c", `user.email=${c.email}`];
}

const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
export function isSafeCheckoutDir(dir: string): boolean {
  return SAFE_PATH.test(dir) && !dir.includes("..") && !dir.startsWith("/");
}

export function checkoutCommand(
  repo: string,
  token: string,
  dir: string,
  identity: { name: string; email: string },
  host = "github.com",
): string {
  const header = authExtraHeader(token);
  return [
    "set -e",
    `git -c 'http.extraheader=${header}' clone -- 'https://${host}/${repo}.git' '${dir}'`,
    `git -C '${dir}' config http.extraheader '${header}'`,
    `git -C '${dir}' config user.name '${identity.name}'`,
    `git -C '${dir}' config user.email '${identity.email}'`,
    conventionProbe(dir),
    skillsProbe(dir),
    "echo __SCM_CHECKOUT_OK__",
  ].join("\n");
}

export const CHECKOUT_OK = "__SCM_CHECKOUT_OK__";

export const CONVENTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export const CONV_MARKER = "__OE_CONV__";

export interface RepoConvention {
  file: string;
  lines: number;
  bytes: number;
}

export function conventionProbe(dir: string): string {
  return (
    `for f in ${CONVENTION_FILES.join(" ")}; do ` +
    `if [ -f '${dir}'/"$f" ]; then ` +
    `echo "${CONV_MARKER} $f $(wc -l < '${dir}'/"$f") $(wc -c < '${dir}'/"$f")"; break; fi; done`
  );
}

export function parseConventionProbe(stdout: string): RepoConvention | null {
  const re = new RegExp(`^${CONV_MARKER}\\s+(\\S+)\\s+(\\d+)\\s+(\\d+)$`);
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(re);
    if (m) return { file: m[1], lines: Number(m[2]), bytes: Number(m[3]) };
  }
  return null;
}

export const SKILL_ROOTS = [".agents/skills", ".claude/skills"] as const;

export const SKILL_MARKER = "__OE_SKILL__";

export const SKILL_TRUNC_MARKER = "__OE_SKILL_TRUNC__";

export const MAX_REPO_SKILLS = 20;
export const MAX_SKILL_BYTES = 32768;

export interface RepoSkillsProbe {
  skills: Record<string, string>;
  truncated: boolean;
}

export function skillsProbe(dir: string): string {
  return (
    `sr=''; for r in ${SKILL_ROOTS.join(" ")}; do ` +
    `if [ -d '${dir}'/"$r" ]; then sr='${dir}'/"$r"; break; fi; done; ` +
    `n=0; if [ -n "$sr" ]; then for d in "$sr"/*/; do ` +
    `if [ -f "$d"SKILL.md ]; then ` +
    `if [ $n -ge ${MAX_REPO_SKILLS} ]; then echo ${SKILL_TRUNC_MARKER}; break; fi; ` +
    `n=$((n+1)); ` +
    `echo "${SKILL_MARKER} $(basename "$d") $(head -c ${MAX_SKILL_BYTES} "$d"SKILL.md | base64 -w0)"; ` +
    `fi; done; fi`
  );
}

function decodeBase64Utf8(b64: string): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
}

export function parseSkillsProbe(stdout: string): RepoSkillsProbe {
  const re = new RegExp(`^${SKILL_MARKER}\\s+(\\S+)\\s+([A-Za-z0-9+/=]+)$`);
  const skills: Record<string, string> = {};
  let truncated = false;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (t === SKILL_TRUNC_MARKER) {
      truncated = true;
      continue;
    }
    const m = t.match(re);
    if (!m || !isSafeSkillName(m[1])) continue;
    const content = decodeBase64Utf8(m[2]);
    if (!content || !content.trim()) continue;
    skills[m[1]] = content;
  }
  return { skills, truncated };
}

export function redactSecret(text: string, ...secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join("[REDACTED]");
    out = out.split(Buffer.from(`x-access-token:${s}`, "utf-8").toString("base64")).join("[REDACTED]");
  }
  return out;
}
