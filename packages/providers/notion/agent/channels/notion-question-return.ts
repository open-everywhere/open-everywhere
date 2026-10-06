import {
  admitInputResponse,
  bareTokenFromEveContext,
  bindFrom,
  forgetBridgedQuestion,
  getOperationalStore,
  readBridgedQuestion,
  rememberBridgedQuestion,
  resolvePartition,
  resolveInboundAnswerRouting,
  type BindableContext,
} from "@open-everywhere/core/agent/adapter-api.js";

export interface NotionAnswerAuth {
  readonly attributes?: Record<string, unknown>;
}

export function notionQuestionContainerKey(discussionId: string): string {
  return `notion:${discussionId}`;
}

export function notionQuestionKey(token: unknown, namespaced: boolean): string | undefined {
  if (typeof token !== "string" || token.length === 0) return undefined;
  return namespaced ? bareTokenFromEveContext(token) : token;
}

function notionDiscussionIdOf(auth: NotionAnswerAuth | undefined): string | undefined {
  const v = auth?.attributes?.["discussion_id"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export async function rememberNotionQuestion(input: {
  readonly org: string;
  readonly namespacedToken: unknown;
  readonly requestId: string;
  readonly discussionId: string;
  readonly wakeId?: string;
}): Promise<boolean> {
  const key = notionQuestionKey(input.namespacedToken, true);
  if (key === undefined) return false;
  return rememberBridgedQuestion(getOperationalStore(), input.org, key, {
    requestId: input.requestId,
    containerKey: notionQuestionContainerKey(input.discussionId),
    ...(input.wakeId ? { wakeId: input.wakeId } : {}),
  });
}

export interface NotionInboundAnswer {
  readonly requestId: string;
  readonly floor: string;
  readonly wakeId?: string;
}

export async function resolveNotionInboundAnswer(input: {
  readonly org: string;
  readonly bareToken: string;
  readonly auth: NotionAnswerAuth;
}): Promise<NotionInboundAnswer | undefined> {
  try {
    const key = notionQuestionKey(input.bareToken, false);
    if (key === undefined) return undefined;
    const discussionId = notionDiscussionIdOf(input.auth);
    const routing = await resolveInboundAnswerRouting(
      {
        internalDispatch: false,
        ...(discussionId ? { containerKey: notionQuestionContainerKey(discussionId) } : {}),
      },
      {
        read: () => readBridgedQuestion(getOperationalStore(), input.org, key),
        admit: async () => {
          const bindable = {
            channel: { kind: "notion" },
            session: { auth: { current: input.auth } },
          } as unknown as BindableContext;
          const p = resolvePartition(bindable);
          return admitInputResponse({
            org: p.org,
            platform: p.platform,
            workspace: p.workspace,
            ...(p.surface === undefined ? {} : { surface: p.surface }),
            surfaceKey: p.surfaceKey,
            principalId: bindFrom(bindable).principalId ?? "",
            responses: 1,
          });
        },
      },
    );
    if (routing.kind !== "answer") return undefined;
    return {
      requestId: routing.requestId,
      floor: routing.floor,
      ...(routing.wakeId !== undefined ? { wakeId: routing.wakeId } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function forgetNotionQuestion(org: string, bareToken: string): Promise<boolean> {
  const key = notionQuestionKey(bareToken, false);
  if (key === undefined) return false;
  return forgetBridgedQuestion(getOperationalStore(), org, key);
}
