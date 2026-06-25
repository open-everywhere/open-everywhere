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
    "echo __SCM_CHECKOUT_OK__",
  ].join("\n");
}

export const CHECKOUT_OK = "__SCM_CHECKOUT_OK__";

export function redactSecret(text: string, ...secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join("[REDACTED]");
    out = out.split(Buffer.from(`x-access-token:${s}`, "utf-8").toString("base64")).join("[REDACTED]");
  }
  return out;
}
