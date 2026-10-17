import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { readLinearIssue, type LinearCommentSummary } from "../channels/linear-api.js";
import { enrichIssueTeam } from "../channels/linear.js";
import { assertLinearIssueAllowed } from "../channels/linear-scope.js";
import { linearWorkMount, linearWorkOrg } from "../channels/linear-work.js";
import {
  ingestUntrustedModelOutput,
  assertTurnSurface,
  TurnOriginFenceError,
  auditOriginFenceRefusal,
  currentTurnIssue,
  currentTurnOrganization,
  noteAuthoredRecordRead,
  workerChatArmMount,
  getConfig,
  preRegisterDynamicEntry,
  resolvePartition,
  declaredWorkspaceTrust,
  ageAtRead,
  type SurfaceTrust,
  type BindableContext,
  type Domain,
} from "@open-everywhere/core/agent/adapter-api.js";

const MAX_COMMENTS = 50;

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

export { ageAtRead as commentAgeAtRead };

function renderComments(comments: readonly LinearCommentSummary[], readAt?: string): string {
  return comments
    .map((c) => {
      const who = c.authorName ?? c.authorId ?? "unknown author";
      const when = c.createdAt ? ` at ${c.createdAt}` : "";
      const age = ageAtRead(c.createdAt, readAt);
      const old = age ? ` (${age} before this read)` : "";
      return `  - ${who}${when}${old}: ${c.text}`;
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
    url: z.string().optional(),
    state: z.string().optional(),
    comments: z.number(),
    truncated: z.boolean(),
    description: z.string(),
    text: z.string(),
    readAt: z.string().optional(),
    workspaceTrust: z.enum(["internal", "public"]).optional(),
  }),
  async execute(input, ctx2) {
    const bctx = ctx2 as BindableContext;
    const domains = getConfig().loadDomains();
    const workOrg = linearWorkOrg(bctx, domains);
    try {
      assertTurnSurface(bctx, "linear");
    } catch (err) {
      if (!(err instanceof TurnOriginFenceError)) throw err;
      if (!workOrg) {
        await auditOriginFenceRefusal(bctx, "linear");
        throw err;
      }
    }
    const issue = input.issue ?? currentTurnIssue(bctx);
    if (!issue) throw new Error("No Linear issue available for this turn — pass `issue` explicitly (its UUID or identifier, e.g. ENG-42).");
    const organizationId = currentTurnOrganization(bctx) ?? workOrg;
    await assertLinearIssueAllowed(bctx, issue, domains, async (ref) => (await enrichIssueTeam(ref, { organizationId }))?.teamId, { workOrg });
    const res = await readLinearIssue(issue, { maxComments: MAX_COMMENTS, organizationId });
    const readAt = new Date().toISOString();
    let workspaceTrust: SurfaceTrust | undefined;
    try {
      workspaceTrust = declaredWorkspaceTrust(resolvePartition(bctx).workspaceKey);
    } catch {
      workspaceTrust = undefined;
    }
    noteAuthoredRecordRead(bctx, {
      kind: "linear-issue",
      id: res.identifier ?? issue,
      alsoKnownAs: [res.id, issue],
      name: res.title,
      url: res.url,
    });
    return {
      ...(workspaceTrust !== undefined ? { workspaceTrust } : {}),
      issue,
      identifier: res.identifier,
      title: res.title,
      ...(res.url !== undefined ? { url: res.url } : {}),
      state: res.stateName,
      comments: res.comments.length,
      truncated: res.truncated,
      description: res.description,
      text: renderComments(res.comments, readAt),
      readAt,
    };
  },
  toModelOutput(output) {
    const ref = output.identifier ?? output.issue;
    const headParts = [`Linear issue ${ref}`];
    if (output.title) headParts.push(output.title);
    if (output.state) headParts.push(`[${output.state}]`);
    if (output.url) headParts.push(output.url);
    const header = headParts.join(" — ");
    const asOf = output.readAt
      ? `\nRead live at ${output.readAt}: the fields above are the issue's state at that moment. The comments below are HISTORY — what a comment claimed about status, approval or progress is not the present state.`
      : "";
    const bodyBlock = output.description.length > 0 ? `\n\nDescription:\n${output.description}` : "\n\n(no description)";
    const commentsBlock =
      output.comments === 0
        ? "\n\nNo comments."
        : `\n\n${output.comments} comment(s), oldest first${output.truncated ? " (truncated — the issue has older comments than these)" : ""}:\n${output.text}`;
    return ingestUntrustedModelOutput(`${header}${asOf}${bodyBlock}${commentsBlock}`, {
      source: `linear issue ${ref}`,
      ingestion: {
        kind: "linear",
        label: "read_linear_issue",
        ...(output.workspaceTrust !== undefined ? { workspaceTrust: output.workspaceTrust } : {}),
      },
    });
  },
});
preRegisterDynamicEntry("read_linear_issue", "_single", readLinearIssueEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const bctx = ctx as BindableContext;
      const ok = workerChatArmMount(bctx, "linear", safeDomains) || linearWorkMount(bctx, safeDomains);
      if (!ok) return null;
      return readLinearIssueEntry;
    },
  },
});
