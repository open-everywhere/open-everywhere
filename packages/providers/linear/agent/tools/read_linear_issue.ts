import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { readLinearIssue, type LinearCommentSummary } from "../channels/linear-api.js";
import { enrichIssueTeam } from "../channels/linear.js";
import { assertLinearIssueAllowed } from "../channels/linear-scope.js";
import {
  ingestUntrustedModelOutput,
  assertTurnSurface,
  currentTurnIssue,
  sourceScopedMount,
  getConfig,
  preRegisterDynamicEntry,
  type BindableContext,
} from "@open-everywhere/core/agent/adapter-api.js";

const MAX_COMMENTS = 50;

function renderComments(comments: readonly LinearCommentSummary[]): string {
  return comments
    .map((c) => {
      const who = c.authorName ?? c.authorId ?? "unknown author";
      const when = c.createdAt ? ` at ${c.createdAt}` : "";
      return `  - ${who}${when}: ${c.text}`;
    })
    .join("\n");
}

export const readLinearIssueEntry = defineTool({
  description:
    "Read a Linear issue — its DESCRIPTION (body) and comment thread. Use it when a reply needs the " +
    "issue's own content or the REST of the discussion beyond the comment you were woken on (already " +
    "in your context): the issue body, or an earlier comment on the same issue. Defaults to THIS issue. " +
    "Bounded; truncates a heavily-commented thread.",
  inputSchema: z.object({
    issue: z
      .string()
      .min(1)
      .optional()
      .describe("The issue to read — its UUID or human identifier (e.g. ENG-42). Defaults to THIS issue (the one the comment you were woken on lives on)."),
  }),
  outputSchema: z.object({
    issue: z.string(),
    identifier: z.string().optional(),
    title: z.string().optional(),
    state: z.string().optional(),
    comments: z.number(),
    truncated: z.boolean(),
    description: z.string(),
    text: z.string(),
  }),
  async execute(input, ctx2) {
    assertTurnSurface(ctx2 as BindableContext, "linear");
    const issue = input.issue ?? currentTurnIssue(ctx2 as BindableContext);
    if (!issue) throw new Error("No Linear issue available for this turn — pass `issue` explicitly (its UUID or identifier, e.g. ENG-42).");
    await assertLinearIssueAllowed(ctx2 as BindableContext, issue, getConfig().loadDomains(), async (ref) => (await enrichIssueTeam(ref))?.teamId);
    const res = await readLinearIssue(issue, { maxComments: MAX_COMMENTS });
    return {
      issue,
      identifier: res.identifier,
      title: res.title,
      state: res.stateName,
      comments: res.comments.length,
      truncated: res.truncated,
      description: res.description,
      text: renderComments(res.comments),
    };
  },
  toModelOutput(output) {
    const ref = output.identifier ?? output.issue;
    const headParts = [`Linear issue ${ref}`];
    if (output.title) headParts.push(output.title);
    if (output.state) headParts.push(`[${output.state}]`);
    const header = headParts.join(" — ");
    const bodyBlock = output.description.length > 0 ? `\n\nDescription:\n${output.description}` : "\n\n(no description)";
    const commentsBlock =
      output.comments === 0
        ? "\n\nNo comments."
        : `\n\n${output.comments} comment(s)${output.truncated ? " (truncated — the issue has more)" : ""}:\n${output.text}`;
    return ingestUntrustedModelOutput(`${header}${bodyBlock}${commentsBlock}`, {
      source: `linear issue ${ref}`,
      ingestion: { kind: "linear", label: "read_linear_issue" },
    });
  },
});
preRegisterDynamicEntry("read_linear_issue", "_single", readLinearIssueEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (!sourceScopedMount(ctx as BindableContext, "linear", () => getConfig().loadDomains())) return null;
      return readLinearIssueEntry;
    },
  },
});
