import type { HttpFetch } from "./contents.js";

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  };
}

export async function getBranchSha(opts: {
  repo: string;
  branch: string;
  token: string;
  fetchFn?: HttpFetch;
  apiBase?: string;
}): Promise<string | null> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as HttpFetch);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const res = await fetchFn(`${apiBase}/repos/${opts.repo}/git/ref/${encodeURIComponent(`heads/${opts.branch}`)}`, {
    method: "GET",
    headers: headers(opts.token),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github get ref ${opts.repo}#${opts.branch}: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { object?: { sha?: string } };
  return typeof body.object?.sha === "string" ? body.object.sha : null;
}

export async function createBranch(opts: {
  repo: string;
  branch: string;
  sha: string;
  token: string;
  fetchFn?: HttpFetch;
  apiBase?: string;
}): Promise<"created" | "exists"> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as HttpFetch);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const res = await fetchFn(`${apiBase}/repos/${opts.repo}/git/refs`, {
    method: "POST",
    headers: headers(opts.token),
    body: JSON.stringify({ ref: `refs/heads/${opts.branch}`, sha: opts.sha }),
  });
  if (res.ok) return "created";
  const text = await res.text();
  if (res.status === 422 && text.includes("Reference already exists")) return "exists";
  throw new Error(`github create ref ${opts.repo}#${opts.branch}: ${res.status} ${text}`);
}

export async function updateRef(opts: {
  repo: string;
  ref: string;
  sha: string;
  force?: boolean;
  token: string;
  fetchFn?: HttpFetch;
  apiBase?: string;
}): Promise<void> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as HttpFetch);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const res = await fetchFn(`${apiBase}/repos/${opts.repo}/git/refs/${opts.ref}`, {
    method: "PATCH",
    headers: headers(opts.token),
    body: JSON.stringify({ sha: opts.sha, force: opts.force === true }),
  });
  if (!res.ok) throw new Error(`github update ref ${opts.repo}#${opts.ref}: ${res.status} ${await res.text()}`);
}

export async function deleteRef(opts: {
  repo: string;
  ref: string;
  token: string;
  fetchFn?: HttpFetch;
  apiBase?: string;
}): Promise<"deleted" | "gone"> {
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as HttpFetch);
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const res = await fetchFn(`${apiBase}/repos/${opts.repo}/git/refs/${opts.ref}`, {
    method: "DELETE",
    headers: headers(opts.token),
  });
  if (res.ok) return "deleted";
  const text = await res.text();
  if (res.status === 404 || (res.status === 422 && text.includes("Reference does not exist"))) return "gone";
  throw new Error(`github delete ref ${opts.repo}#${opts.ref}: ${res.status} ${text}`);
}
