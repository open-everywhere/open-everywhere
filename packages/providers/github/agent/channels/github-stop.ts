import {
  cancelAnchoredTurn,
  isStopDirective,
  resolvePartition,
  turnChannelKey,
  type AttachSessionForCancel,
  type CancelOutcome,
} from "@open-everywhere/core/agent/adapter-api.js";
import { buildGitHubAuth, githubConversationKey } from "./github-identity.js";

const STOP_EVENT_TYPES = new Set(["issue_comment", "pull_request_review_comment"]);

export interface GitHubStopComment {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly authorLogin: string;
  readonly repoPrivate?: boolean;
}

export type GitHubStopOutcome =
  | { readonly stopped: false; readonly reason: string }
  | { readonly stopped: true; readonly outcome: CancelOutcome };

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pick(o: unknown, k: string): unknown {
  return isObject(o) ? o[k] : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function githubCommentIsMachine(comment: unknown): boolean {
  const login = str(pick(pick(comment, "user"), "login"));
  if (!login) return true;
  const type = str(pick(pick(comment, "user"), "type"));
  return type?.toLowerCase() === "bot" || login.endsWith("[bot]");
}

export function parseGitHubStopComment(body: string, eventType: string): GitHubStopComment | null {
  if (!STOP_EVENT_TYPES.has(eventType)) return null;
  let ev: unknown;
  try {
    ev = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObject(ev)) return null;
  if (ev["action"] !== "created") return null;
  const comment = ev["comment"];
  if (!isStopDirective(str(pick(comment, "body")))) return null;
  if (githubCommentIsMachine(comment)) return null;
  const repository = ev["repository"];
  const owner = str(pick(pick(repository, "owner"), "login"));
  const repo = str(pick(repository, "name"));
  const number = num(pick(ev["issue"], "number")) ?? num(pick(ev["pull_request"], "number"));
  const authorLogin = str(pick(pick(comment, "user"), "login"));
  if (!owner || !repo || number === undefined || !authorLogin) return null;
  const repoPrivate = pick(repository, "private");
  return { owner, repo, number, authorLogin, ...(typeof repoPrivate === "boolean" ? { repoPrivate } : {}) };
}

export interface GitHubStopDeps {
  readonly attachSession: AttachSessionForCancel;
  readonly cancel?: typeof cancelAnchoredTurn;
}

export async function routeGitHubStopComment(stop: GitHubStopComment, deps: GitHubStopDeps): Promise<GitHubStopOutcome> {
  const conversationKey = githubConversationKey(stop.owner, stop.repo, stop.number);
  const channelKey = conversationKey ? turnChannelKey("github", conversationKey) : undefined;
  if (!channelKey) return { stopped: false, reason: "stop: no conversation key" };
  const partition = resolvePartition({
    channel: { kind: "github" },
    session: {
      auth: {
        current: buildGitHubAuth({
          owner: stop.owner,
          repo: stop.repo,
          issueNumber: stop.number,
          actorLogin: stop.authorLogin,
          ...(stop.repoPrivate === undefined ? {} : { isPrivate: stop.repoPrivate }),
        }),
      },
    },
  });
  const result = await (deps.cancel ?? cancelAnchoredTurn)({
    org: partition.org,
    platform: "github",
    workspace: partition.workspace,
    requestedBy: stop.authorLogin,
    via: "reaction",
    query: { channelKey },
    attachSession: deps.attachSession,
  });
  return { stopped: true, outcome: result.outcome };
}
