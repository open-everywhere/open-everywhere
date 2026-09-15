import type { GithubDriverConfig } from "./env.js";
import { pollUntil } from "./poll.js";
import { buildIssueCommentEvent, signGithubBody, type IssueCommentForgeInput } from "./github-forge.js";

export function engagedRepoSkipReason(repo: string, isPrivate: boolean | undefined): string | undefined {
  if (isPrivate !== false) return undefined;
  return (
    `${repo} is PUBLIC — the engaged follow-up arm floors on a private repository (githubEngagedFollowUpReach: a plain ` +
    `follow-up wakes a full native turn, which a public repo would let any passer-by buy), so step (b) is unreachable ` +
    `here for a configuration reason. Make the fixture repo private (Settings → General → Danger Zone), or point ` +
    `E2E_ADDRESSED_GITHUB_REPO at a private repo`
  );
}

export interface GithubComment {
  readonly id: number;
  readonly body: string;
  readonly authorLogin: string;
  readonly authorType: string;
  readonly createdAt: string;
}

interface GithubApiComment {
  id?: number;
  body?: string;
  user?: { login?: string; type?: string };
  created_at?: string;
}

export function githubCommentAtOrAfter(createdAt: string, boundIso: string): boolean {
  const at = Date.parse(createdAt);
  const bound = Date.parse(boundIso);
  if (Number.isNaN(at) || Number.isNaN(bound)) return true;
  return at >= Math.floor(bound / 1000) * 1000;
}

export class GithubDriver {
  constructor(private readonly cfg: GithubDriverConfig) {}

  get repo(): string {
    return this.cfg.repo;
  }

  get fixtureIssue(): number {
    return Number.parseInt(this.cfg.issue, 10);
  }

  mention(ask: string): string {
    return `@${this.cfg.appSlug} ${ask}`;
  }

  get botLogin(): string {
    return `${this.cfg.appSlug}[bot]`;
  }

  private async api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
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
    return (await res.json()) as Record<string, unknown>;
  }

  async isPrivate(): Promise<boolean | undefined> {
    const json = await this.api("GET", `/repos/${this.cfg.repo}`).catch(() => undefined);
    return typeof json?.private === "boolean" ? json.private : undefined;
  }

  async createIssue(title: string, bodyText: string): Promise<number> {
    const json = await this.api("POST", `/repos/${this.cfg.repo}/issues`, { title, body: bodyText });
    const number = typeof json.number === "number" ? json.number : undefined;
    if (number === undefined) throw new Error("github issue create returned no number");
    return number;
  }

  async closeIssue(issueNumber: number): Promise<void> {
    await this.api("PATCH", `/repos/${this.cfg.repo}/issues/${issueNumber}`, { state: "closed" }).catch(() => undefined);
  }

  async comment(issueNumber: number, body: string): Promise<number> {
    const json = await this.api("POST", `/repos/${this.cfg.repo}/issues/${issueNumber}/comments`, { body });
    const id = typeof json.id === "number" ? json.id : undefined;
    if (id === undefined) throw new Error("github comment create returned no id");
    return id;
  }

  async comments(issueNumber: number): Promise<readonly GithubComment[]> {
    const json = (await this.api("GET", `/repos/${this.cfg.repo}/issues/${issueNumber}/comments?per_page=100`)) as unknown as GithubApiComment[];
    const arr = Array.isArray(json) ? json : [];
    return arr.map((c) => ({ id: c.id ?? 0, body: c.body ?? "", authorLogin: c.user?.login ?? "", authorType: c.user?.type ?? "", createdAt: c.created_at ?? "" }));
  }

  isBotComment(c: GithubComment): boolean {
    return c.authorLogin === this.botLogin || c.authorType === "Bot";
  }

  async awaitBotReply(issueNumber: number, afterCommentId: number, opts: { timeoutMs: number; skip?: (c: GithubComment) => boolean }): Promise<GithubComment> {
    return pollUntil(
      async () => (await this.comments(issueNumber)).find((c) => this.isBotComment(c) && c.id > afterCommentId && !(opts.skip?.(c) ?? false)),
      {
        timeoutMs: opts.timeoutMs,
        what: `a ${this.botLogin} reply on issue #${issueNumber} after comment ${afterCommentId}${opts.skip !== undefined ? " that is not skipped as an interim post" : ""}`,
      },
    );
  }

  async reactions(commentId: number): Promise<readonly string[]> {
    const json = (await this.api("GET", `/repos/${this.cfg.repo}/issues/comments/${commentId}/reactions`)) as unknown as { content?: string }[];
    return (Array.isArray(json) ? json : []).map((r) => r.content ?? "").filter(Boolean);
  }

  get canForge(): boolean {
    return typeof this.cfg.webhookSecret === "string" && typeof this.cfg.installationId === "string";
  }

  async forgeIssueComment(
    targetUrl: string,
    input: Omit<IssueCommentForgeInput, "installationId">,
    opts: { signed?: boolean } = {},
  ): Promise<{ status: number }> {
    if (!this.cfg.webhookSecret || !this.cfg.installationId) throw new Error("forge leg needs E2E_GITHUB_WEBHOOK_SECRET + E2E_GITHUB_INSTALLATION_ID");
    const payload = buildIssueCommentEvent({ ...input, installationId: Number.parseInt(this.cfg.installationId, 10) });
    const rawBody = JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json", "x-github-event": "issue_comment" };
    if (opts.signed !== false) headers["x-hub-signature-256"] = signGithubBody(this.cfg.webhookSecret, rawBody);
    const res = await fetch(`${targetUrl.replace(/\/+$/, "")}/eve/v1/github`, { method: "POST", headers, body: rawBody });
    return { status: res.status };
  }
}
