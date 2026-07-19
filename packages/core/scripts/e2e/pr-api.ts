import type { PrConfig } from "./env.js";

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
    const json = (await this.api("GET", `/repos/${this.cfg.repo}/pulls?state=open&per_page=100`)) as PrApiPull[];
    const arr = Array.isArray(json) ? json : [];
    const pr = arr.find((p) => p.head?.ref === head);
    if (!pr || typeof pr.number !== "number") return undefined;
    return { number: pr.number, head: pr.head?.ref ?? "", base: pr.base?.ref ?? "", title: pr.title ?? "" };
  }

  async prContainsToken(prNumber: number, token: string): Promise<boolean> {
    const json = (await this.api("GET", `/repos/${this.cfg.repo}/pulls/${prNumber}/files?per_page=100`)) as PrApiFile[];
    const files = Array.isArray(json) ? json : [];
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
