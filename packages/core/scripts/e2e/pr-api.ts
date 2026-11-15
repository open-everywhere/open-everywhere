import type { PrConfig } from "./env.js";
import { GITHUB_PAGE_SIZE, walkGithubPages } from "./github-driver.js";

export interface PrDetails {
  readonly number: number;
  readonly head: string;
  readonly base: string;
  readonly title: string;
}

interface PrApiPull {
  number?: number;
  title?: string;
  head?: { ref?: string };
  base?: { ref?: string };
}

interface PrApiFile {
  filename?: string;
  patch?: string;
}

export class PrApi {
  constructor(private readonly cfg: PrConfig) {}

  get repo(): string {
    return this.cfg.repo;
  }

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`github ${method} ${path} → ${res.status}${detail ? ` (${detail})` : ""}`);
    }
    if (res.status === 204) return {};
    const text = await res.text();
    return text ? (JSON.parse(text) as unknown) : {};
  }

  async getPr(prNumber: number): Promise<PrDetails | undefined> {
    const pr = (await this.api("GET", `/repos/${this.cfg.repo}/pulls/${prNumber}`)) as PrApiPull;
    if (typeof pr.number !== "number") return undefined;
    return { number: pr.number, head: pr.head?.ref ?? "", base: pr.base?.ref ?? "", title: pr.title ?? "" };
  }

  async findOpenPrByHead(head: string): Promise<PrDetails | undefined> {
    const arr = await walkGithubPages(`pulls?state=open`, async (page) => {
      const json = (await this.api("GET", `/repos/${this.cfg.repo}/pulls?state=open&per_page=${GITHUB_PAGE_SIZE}&page=${page}`)) as PrApiPull[];
      return Array.isArray(json) ? json : [];
    });
    const pr = arr.find((p) => p.head?.ref === head);
    if (!pr || typeof pr.number !== "number") return undefined;
    return { number: pr.number, head: pr.head?.ref ?? "", base: pr.base?.ref ?? "", title: pr.title ?? "" };
  }

  async prContainsToken(prNumber: number, token: string): Promise<boolean> {
    const files = await walkGithubPages(`pulls/${prNumber}/files`, async (page) => {
      const json = (await this.api("GET", `/repos/${this.cfg.repo}/pulls/${prNumber}/files?per_page=${GITHUB_PAGE_SIZE}&page=${page}`)) as PrApiFile[];
      return Array.isArray(json) ? json : [];
    });
    return files.some((f) => typeof f.patch === "string" && f.patch.includes(token));
  }

  async fileText(path: string, ref: string): Promise<string | undefined> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    let json: { content?: unknown; encoding?: unknown };
    try {
      json = (await this.api("GET", `/repos/${this.cfg.repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`)) as typeof json;
    } catch (err) {
      if (/→ 404\b/.test(String(err instanceof Error ? err.message : err))) return undefined;
      throw err;
    }
    if (json.encoding !== "base64" || typeof json.content !== "string") throw new Error(`github contents ${path}@${ref}: not a base64 file body`);
    return Buffer.from(json.content, "base64").toString("utf8");
  }

  async isPrivate(): Promise<boolean> {
    const json = (await this.api("GET", `/repos/${this.cfg.repo}`)) as { private?: unknown };
    return json.private === true;
  }

  async branchExists(head: string): Promise<boolean> {
    try {
      await this.api("GET", `/repos/${this.cfg.repo}/git/ref/heads/${encodeURIComponent(head)}`);
      return true;
    } catch (err) {
      if (/→ 404\b/.test(String(err instanceof Error ? err.message : err))) return false;
      throw err;
    }
  }

  async closePr(prNumber: number): Promise<void> {
    await this.api("PATCH", `/repos/${this.cfg.repo}/pulls/${prNumber}`, { state: "closed" });
  }

  async deleteBranch(head: string): Promise<void> {
    if (!head) return;
    await this.api("DELETE", `/repos/${this.cfg.repo}/git/refs/heads/${encodeURIComponent(head)}`);
  }
}
