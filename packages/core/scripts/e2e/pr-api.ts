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

export interface PrTaintShape {
  readonly repoPrivate?: boolean;
  readonly thirdPartyBodies: number;
}

interface PrApiBody {
  body?: string;
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

  async prTaintShape(prNumber: number): Promise<PrTaintShape> {
    const pr = (await this.api("GET", `/repos/${this.cfg.repo}/pulls/${prNumber}`)) as { base?: { repo?: { private?: boolean } } };
    const priv = pr.base?.repo?.private;
    const nonEmpty = async (path: string): Promise<number> => {
      const items = await walkGithubPages(path, async (page) => {
        const json = (await this.api("GET", `${path}?per_page=${GITHUB_PAGE_SIZE}&page=${page}`)) as PrApiBody[];
        return Array.isArray(json) ? json : [];
      });
      return items.filter((c) => typeof c.body === "string" && c.body.trim().length > 0).length;
    };
    const counts = await Promise.all([
      nonEmpty(`/repos/${this.cfg.repo}/pulls/${prNumber}/reviews`),
      nonEmpty(`/repos/${this.cfg.repo}/pulls/${prNumber}/comments`),
      nonEmpty(`/repos/${this.cfg.repo}/issues/${prNumber}/comments`),
    ]);
    return {
      ...(typeof priv === "boolean" ? { repoPrivate: priv } : {}),
      thirdPartyBodies: counts.reduce((a, b) => a + b, 0),
    };
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

  async closePr(prNumber: number): Promise<void> {
    await this.api("PATCH", `/repos/${this.cfg.repo}/pulls/${prNumber}`, { state: "closed" });
  }

  async deleteBranch(head: string): Promise<void> {
    if (!head) return;
    await this.api("DELETE", `/repos/${this.cfg.repo}/git/refs/heads/${encodeURIComponent(head)}`);
  }
}
