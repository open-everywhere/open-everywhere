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
