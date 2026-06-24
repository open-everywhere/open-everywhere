import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { auditToolAction } from "../audit/tool-action.js";

export default defineTool({
  description:
    "Open a GitHub pull request. This is a consequential write and will pause for human approval before it runs.",
  inputSchema: z.object({
    repo: z.string().describe("Target repository as 'owner/repo'."),
    head: z.string().describe("The branch containing the changes."),
    base: z.string().default("main").describe("The branch to merge into."),
    title: z.string().describe("PR title."),
    body: z.string().describe("PR description (markdown)."),
  }),
  needsApproval: always(),
  async execute(input, ctx) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is not set.");

    const res = await fetch(
      `https://api.github.com/repos/${input.repo}/pulls`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
        }),
      },
    );

    if (!res.ok) {
      throw new Error(`GitHub PR creation failed: ${res.status} ${await res.text()}`);
    }

    const pr = (await res.json()) as { html_url: string; number: number };

    await auditToolAction(ctx, "pr.open", {
      repo: input.repo,
      head: input.head,
      base: input.base,
      number: pr.number,
      url: pr.html_url,
    });

    return { url: pr.html_url, number: pr.number };
  },
});
