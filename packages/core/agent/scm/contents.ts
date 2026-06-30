import type { Selector } from "../memory/selection.js";

const API = "https://api.github.com";

export type HttpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export interface CommitId {
  readonly name: string;
  readonly email: string;
}

interface ContentEntry {
  type: string;
  path: string;
  name: string;
  sha: string;
}
interface FileResponse {
  content?: string;
  encoding?: string;
  sha: string;
}
interface WriteResponse {
  commit?: { sha?: string };
  content?: { sha?: string };
}

export class GitHubContents {
  constructor(
    private readonly fetchFn: HttpFetch = globalThis.fetch as unknown as HttpFetch,
    private readonly apiBase: string = API,
  ) {}

  private headers(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    };
  }

  private url(repo: string, path: string): string {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return `${this.apiBase}/repos/${repo}/contents/${encoded}`;
  }

  async listFiles(repo: string, dir: string, branch: string, token: string, selector: Selector): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const walk = async (path: string, segs: string[]): Promise<void> => {
      const res = await this.fetchFn(`${this.url(repo, path)}?ref=${encodeURIComponent(branch)}`, {
        method: "GET",
        headers: this.headers(token),
      });
      if (res.status === 404) return;
      if (!res.ok) throw new Error(`github contents list ${repo}/${path}: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as ContentEntry[] | ContentEntry;
      const entries = Array.isArray(body) ? body : [body];
      for (const e of entries) {
        if (e.type === "dir") {
          if (selector.descends([...segs, e.name])) await walk(e.path, [...segs, e.name]);
        } else if (e.type === "file" && selector.includesLeaf(segs, e.name)) {
          out[e.path.slice(dir.length + 1)] = e.sha;
        }
      }
    };
    await walk(dir, []);
    return out;
  }

  async getFile(repo: string, path: string, branch: string, token: string): Promise<{ content: string; sha: string } | null> {
    const res = await this.fetchFn(`${this.url(repo, path)}?ref=${encodeURIComponent(branch)}`, {
      method: "GET",
      headers: this.headers(token),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`github get ${repo}/${path}: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as FileResponse;
    const content = body.encoding === "base64" && body.content ? Buffer.from(body.content, "base64").toString("utf-8") : "";
    return { content, sha: body.sha };
  }

  async putFile(
    repo: string,
    path: string,
    content: string,
    message: string,
    branch: string,
    token: string,
    committer: CommitId,
    sha?: string,
  ): Promise<string | null> {
    const res = await this.fetchFn(this.url(repo, path), {
      method: "PUT",
      headers: this.headers(token),
      body: JSON.stringify({
        message,
        content: Buffer.from(content, "utf-8").toString("base64"),
        branch,
        committer,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) throw new Error(`github put ${repo}/${path}: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as WriteResponse;
    return body.commit?.sha ?? body.content?.sha ?? null;
  }

  async deleteFile(repo: string, path: string, sha: string, message: string, branch: string, token: string, committer: CommitId): Promise<void> {
    const res = await this.fetchFn(this.url(repo, path), {
      method: "DELETE",
      headers: this.headers(token),
      body: JSON.stringify({ message, sha, branch, committer }),
    });
    if (res.status === 404) return;
    if (!res.ok) throw new Error(`github delete ${repo}/${path}: ${res.status} ${await res.text()}`);
  }
}
