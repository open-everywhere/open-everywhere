import { normalizeGithubEvent } from "./events.js";
import { registerEventNormalizer, type EventNormalizer, type NormalizedEvent, type ScopeStep, type TriggerDelivery } from "./event-model.js";
import { registerEventScopeGrant, type EventScopeGrant } from "./event-authz.js";
import { repoAllowed } from "../scm/provider.js";
import { scopeIdOf } from "./event-model.js";

export const GITHUB_EVENT_SOURCE = "github";

const EVENT_HEADER = "x-github-event";

const DELIVERY_ID_HEADER = "x-github-delivery";

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function subjectOf(payload: Record<string, unknown>): { entity?: string; fetchable?: boolean; sub?: string } {
  const out: { entity?: string; fetchable?: boolean; sub?: string } = {};
  const subject =
    obj(payload["pull_request"]) ??
    obj(payload["issue"]) ??
    obj(payload["check_run"]) ??
    obj(payload["release"]) ??
    obj(payload["workflow_run"]);
  const num = subject?.["number"];
  const id = subject?.["id"];
  if (typeof num === "number") {
    out.entity = String(num);
    out.fetchable = true;
  } else if (typeof id === "number" || typeof id === "string") {
    out.entity = String(id);
    out.fetchable = false;
  }
  const commentId = obj(payload["comment"])?.["id"];
  if (typeof commentId === "number" || typeof commentId === "string") out.sub = String(commentId);
  return out;
}

function workflowRunFields(payload: Record<string, unknown>): Record<string, string> {
  const run = obj(payload["workflow_run"]);
  if (!run) return {};
  const out: Record<string, string> = {};
  const branch = str(run["head_branch"]);
  if (branch) out["branch"] = branch;
  const status = str(run["status"]);
  if (status) out["status"] = status;
  const conclusion = str(run["conclusion"]);
  if (conclusion) out["conclusion"] = conclusion;
  const workflow = str(run["name"]) ?? str(obj(payload["workflow"])?.["name"]);
  if (workflow) out["workflow"] = workflow;
  return out;
}

export function liftGithubEvent(eventType: string, payload: Record<string, unknown>, deliveryId?: string): NormalizedEvent | null {
  const v1 = normalizeGithubEvent(eventType, payload);
  if (!v1) return null;

  const scope: ScopeStep[] = [];
  const repo = v1.repo;
  if (repo) {
    const owner = repo.split("/")[0];
    if (owner) scope.push({ kind: "tenant", id: owner });
    scope.push({ kind: "container", id: repo, ...(str(obj(payload["repository"])?.["name"]) ? { label: obj(payload["repository"])!["name"] as string } : {}) });
  }
  const subject = subjectOf(payload);
  if (subject.entity !== undefined) scope.push({ kind: "entity", id: subject.entity, ...(v1.title ? { label: v1.title } : {}) });
  if (subject.sub !== undefined) scope.push({ kind: "sub", id: subject.sub });

  const gone = v1.action === "deleted";

  const fields: Record<string, string> = { event: v1.event };
  if (v1.action) fields["action"] = v1.action;
  if (repo) fields["repo"] = repo;
  if (v1.sender) fields["sender"] = v1.sender;
  if (v1.number !== undefined) fields["number"] = String(v1.number);
  if (v1.title) fields["title"] = v1.title;
  if (v1.url) fields["url"] = v1.url;
  Object.assign(fields, workflowRunFields(payload));

  return {
    source: GITHUB_EVENT_SOURCE,
    event: v1.event,
    ...(v1.action ? { action: v1.action } : {}),
    scope,
    ...(v1.sender ? { actor: { id: v1.sender, handle: v1.sender } } : {}),
    fields,
    ...(deliveryId ? { deliveryId } : {}),
    summary: v1.summary,
    ...(repo && subject.entity !== undefined && subject.fetchable === true
      ? { pointer: { platform: "github", id: `${repo}#${subject.entity}`, ...(gone ? { gone: true } : {}) } }
      : {}),
  };
}

export const githubEventNormalizer: EventNormalizer = {
  source: GITHUB_EVENT_SOURCE,
  matchKeys: ["event", "action", "repo", "sender", "branch", "status", "conclusion", "workflow"],
  scopeKeys: ["repo"],
  scopeKinds: ["tenant", "container", "entity", "sub"],
  resolvesActor: true,
  deliveryIdHeader: DELIVERY_ID_HEADER,
  normalize(d: TriggerDelivery): NormalizedEvent | null {
    const eventType = d.headers[EVENT_HEADER] ?? "";
    if (!eventType) return null;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(d.body) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (!payload || typeof payload !== "object") return null;
    return liftGithubEvent(eventType, payload, d.deliveryId);
  },
};

export const githubEventScopeGrant: EventScopeGrant = {
  source: GITHUB_EVENT_SOURCE,
  grantsRead(scope, access) {
    const repo = scopeIdOf(scope, "container");
    return repo !== undefined && repoAllowed(repo, access.repos);
  },
};

registerEventNormalizer(githubEventNormalizer);
registerEventScopeGrant(githubEventScopeGrant);
