import { createHmac } from "node:crypto";

export function signGithubBody(secret: string, rawBody: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export interface IssueCommentForgeInput {
  readonly commentId: number;
  readonly body: string;
  readonly driverLogin: string;
  readonly issueNumber: number;
  readonly repoFullName: string;
  readonly installationId: number;
}

export function buildIssueCommentEvent(input: IssueCommentForgeInput): Record<string, unknown> {
  const [owner, name] = input.repoFullName.split("/");
  return {
    action: "created",
    comment: {
      id: input.commentId,
      body: input.body,
      user: { login: input.driverLogin, type: "User" },
      author_association: "MEMBER",
    },
    issue: { number: input.issueNumber },
    repository: { full_name: input.repoFullName, owner: { login: owner }, name, private: true },
    installation: { id: input.installationId },
  };
}
