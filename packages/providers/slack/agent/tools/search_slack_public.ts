import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  auditToolAction,
  bindFrom,
  currentTurnId,
  ingestUntrustedModelOutput,
  requesterThisTurn,
  resolveAccessFor,
  seatServesManyAskers,
  sessionMountedTool,
  projectReadText,
  readAuthorWithhold,
  type BindableContext,
  type RequesterVerdict,
} from "@open-everywhere/core/agent/adapter-api.js";
import { runSlackPublicSearch, SLACK_PUBLIC_SEARCH_MAX, SLACK_PUBLIC_SEARCH_TOOL, SlackPublicSearchRefusedError, type SlackSearchCall } from "../channels/slack-public-search.js";
import { slackReadAdapter } from "../channels/slack-read.js";
import type { SlackMemberProbe } from "../channels/slack-events.js";

const DEFAULT_LIMIT = 10;

function hitTime(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) return "time unknown";
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function slackPublicSearchGranted(ctx: BindableContext): boolean {
  try {
    if (bindFrom(ctx).platform !== "slack") return false;
    return resolveAccessFor(ctx).optInTools.includes(SLACK_PUBLIC_SEARCH_TOOL);
  } catch {
    return false;
  }
}

export interface SlackPublicSearchDeps {
  readonly call?: SlackSearchCall;
  readonly probe?: SlackMemberProbe;
  readonly requester?: RequesterVerdict;
}

export async function executeSlackPublicSearch(input: { readonly query: string; readonly limit?: number }, ctx: BindableContext, deps: SlackPublicSearchDeps = {}) {
  if (!slackPublicSearchGranted(ctx)) {
    await auditToolAction(ctx, "slack.public_search.refused", { reason: "not-granted" });
    throw new Error(
      "Public-channel Slack search is not switched on for this channel. An admin switches it on with " +
        '`optInTools: ["search_slack_public"]` on a bundle bound to this domain or room (agent/access/bundles.ts).',
    );
  }
  const asker = { verdict: deps.requester ?? requesterThisTurn(currentTurnId(ctx)), manyAskers: seatServesManyAskers(ctx) };
  let found: Awaited<ReturnType<typeof runSlackPublicSearch>>;
  let lines: { author: string; ts: string; text: string; authorId?: string; bot?: boolean }[];
  let withheld: (m: (typeof lines)[number]) => boolean;
  try {
    found = await runSlackPublicSearch(ctx, input.query, input.limit ?? DEFAULT_LIMIT, asker, deps.call);
    lines = found.hits.map((h, i) => ({ author: h.author, ts: h.ts, text: h.text, ...found.authors[i] }));
    withheld = await readAuthorWithhold(ctx, { refutedAuthorIds: (c, l) => slackReadAdapter.refutedAuthorIds(c, l, deps.probe) }, lines);
  } catch (err) {
    if (err instanceof SlackPublicSearchRefusedError) {
      await auditToolAction(ctx, "slack.public_search.refused", { reason: err.reason, ...(err.requester ? { requester: err.requester } : {}) });
    } else {
      await auditToolAction(ctx, "slack.public_search.refused", { reason: "error" });
    }
    throw err;
  }
  await auditToolAction(ctx, "slack.public_search", { requester: found.requester, resultCount: found.hits.length });
  return { query: input.query, hits: found.hits.map((h, i) => ({ ...h, text: projectReadText(lines[i]!, withheld(lines[i]!)) })) };
}

export const searchSlackPublicEntry = defineTool({
  description:
    "Search the Slack workspace's PUBLIC channels — including channels you are not in — as the person who asked, " +
    "and get back matching messages with the channel name, the author, the time and a link. It runs only on a turn " +
    "woken by that person's own message to you (an @mention or a DM): Slack ties the search to that message. " +
    "Cite the link for anything you use. It never reaches private channels or DMs.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Words to search for."),
    limit: z.number().int().min(1).max(SLACK_PUBLIC_SEARCH_MAX).optional().describe(`How many messages to return (default ${DEFAULT_LIMIT}, max ${SLACK_PUBLIC_SEARCH_MAX}).`),
  }),
  outputSchema: z.object({
    query: z.string(),
    hits: z.array(z.object({ channel: z.string(), author: z.string(), ts: z.string(), permalink: z.string().optional(), text: z.string() })),
  }),
  async execute(input, ctx) {
    return await executeSlackPublicSearch(input, ctx as unknown as BindableContext);
  },
  toModelOutput(output) {
    const body =
      output.hits.length === 0
        ? `Public-channel Slack search for "${output.query}" matched no message.`
        : `Public-channel Slack search for "${output.query}" — ${output.hits.length} message(s):\n` +
          output.hits.map((h) => `- ${h.channel} · ${h.author} · ${hitTime(h.ts)}${h.permalink ? ` · ${h.permalink}` : ""}\n  ${h.text.replace(/\n/gu, "\n  ")}`).join("\n");
    return ingestUntrustedModelOutput(body, {
      source: "slack public search",
      toolName: "search_slack_public",
    });
  },
});
export default sessionMountedTool("search_slack_public", searchSlackPublicEntry, (ctx) => slackPublicSearchGranted(ctx));
