import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { capResult } from "../access/result-cap.js";
import { docIndex, readDoc } from "../docs/registry.js";
import { auditToolAction } from "../audit/tool-action.js";
import { docUrl } from "../ops/quickstart.js";

export default defineTool({
  description:
    "Read this agent's own shipped documentation — how this agent works, what it can do, how a capability is set up and governed. Call with no path to list the manual this deployment ships, then again with a path to read one doc. Use it before answering any question about how the agent works rather than assuming; only the docs for the surfaces this deployment actually carries are present. To point a person at a doc, give its `url`, never its path. For this deployment's own admins, connections and what an admin can change from chat, use the `setup` part of `agent_version` instead: the manual describes every deployment, not this one.",
  inputSchema: z.object({
    path: z
      .string()
      .optional()
      .describe('Doc to read, e.g. "docs/capabilities/memory.md". A cross-reference from another doc ("../../capabilities/memory.md") works too. Omit to list the manual.'),
  }),
  outputSchema: z.object({
    docs: z.array(z.object({ path: z.string(), title: z.string(), summary: z.string() })).optional(),
    path: z.string().optional(),
    title: z.string().optional(),
    content: z.string().optional(),
    url: z.string().optional().describe("The doc's public web page — the link to give a person (OPE-2492). Its path names nothing a person can open."),
  }),
  approval: never(),
  async execute(input, ctx): Promise<{
    docs?: { path: string; title: string; summary: string }[];
    path?: string;
    title?: string;
    content?: string;
    url?: string;
  }> {
    const requested = input.path?.trim();
    if (!requested) {
      const docs = [...docIndex()];
      await auditToolAction(ctx, "docs.index", { count: docs.length });
      return { docs };
    }
    const found = readDoc(requested);
    if (!found.ok) {
      await auditToolAction(ctx, "docs.refused", { requested });
      throw new Error(found.message);
    }
    await auditToolAction(ctx, "docs.read", { path: found.doc.path });
    return { path: found.doc.path, title: found.doc.title, content: capResult(found.doc.markdown), url: docUrl(found.doc.path) };
  },
});
