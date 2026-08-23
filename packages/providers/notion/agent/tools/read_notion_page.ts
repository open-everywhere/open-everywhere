import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { readNotionPage, resolveBlockOwningPage, resolveNotionCredential } from "../channels/notion-api.js";
import { notionCallerCredential } from "../channels/notion-credentials.js";
import { assertNotionPageAllowed, assertNotionPageAllowedOrResolveBlock, assertNotionWorkPageAllowed } from "../channels/notion-scope.js";
import { notionWorkGrant, notionWorkMount, notionWorkspacesOf, type NotionWorkGrant } from "../channels/notion-work.js";
import {
  ingestUntrustedModelOutput,
  assertTurnSurface,
  TurnOriginFenceError,
  auditOriginFenceRefusal,
  bindFrom,
  sourceScopedMount,
  getConfig,
  preRegisterDynamicEntry,
  resolvePartition,
  declaredWorkspaceTrust,
  type SurfaceTrust,
  type BindableContext,
} from "@open-everywhere/core/agent/adapter-api.js";

const MAX_CHARS = 20_000;
const MAX_BLOCKS = 200;

export const readNotionPageEntry = defineTool({
        description:
          "Read the text of a Notion page (this doc, or another page shared with the integration). " +
          "Use it when a reply needs the doc's own content — to answer a question about the page or " +
          "catch a problem in it. Returns the page's top-level text (truncated if very long); the " +
          "comment thread you were woken on is already in your context.",
        inputSchema: z.object({
          page: z
            .string()
            .min(1)
            .optional()
            .describe("The Notion page id to read (e.g. a UUID). Defaults to THIS doc — the page the comment you're on lives in."),
        }),
        outputSchema: z.object({
          page: z.string(),
          blocks: z.number(),
          truncated: z.boolean(),
          text: z.string(),
          readAt: z.string().optional(),
          workspaceTrust: z.enum(["internal", "public"]).optional(),
        }),
        async execute(input, ctx2) {
          const domains = getConfig().loadDomains();
          let workGrant: NotionWorkGrant | undefined;
          try {
            assertTurnSurface(ctx2 as BindableContext, "notion");
          } catch (err) {
            if (!(err instanceof TurnOriginFenceError)) throw err;
            workGrant = notionWorkGrant(ctx2 as BindableContext, domains);
            if (!workGrant) {
              await auditOriginFenceRefusal(ctx2 as BindableContext, "notion");
              throw err;
            }
          }
          const requestedPage = input.page ?? (workGrant ? undefined : bindFrom(ctx2 as BindableContext).surface);
          if (!requestedPage) {
            throw new Error(
              workGrant
                ? "Pass `page` explicitly — this session was not woken on a Notion page, so there is no page to default to."
                : "No Notion page id available for this session — pass `page` explicitly.",
            );
          }
          const credentialId = workGrant ? workGrant.credential : notionCallerCredential(ctx2 as BindableContext, domains);
          const cred = await resolveNotionCredential(credentialId);
          let page: string;
          if (workGrant) {
            await assertNotionWorkPageAllowed(
              ctx2 as BindableContext,
              requestedPage,
              workGrant.domain,
              domains,
              notionWorkspacesOf(workGrant.domain),
            );
            page = requestedPage;
          } else if (cred) {
            page = await assertNotionPageAllowedOrResolveBlock(ctx2 as BindableContext, requestedPage, domains, (id) => resolveBlockOwningPage(id, { ...cred }));
          } else {
            await assertNotionPageAllowed(ctx2 as BindableContext, requestedPage, domains);
            page = requestedPage;
          }
          if (!cred) {
            throw new Error(
              workGrant
                ? `no value stored for this domain's Notion work credential "${credentialId}" — cannot read the page.`
                : "no value stored under db:notion:channel-key — cannot read the page.",
            );
          }
          const res = await readNotionPage(page, { ...cred, maxChars: MAX_CHARS, maxBlocks: MAX_BLOCKS });
          const readAt = new Date().toISOString();
          let workspaceTrust: SurfaceTrust | undefined;
          if (!workGrant) {
            try {
              workspaceTrust = declaredWorkspaceTrust(resolvePartition(ctx2 as BindableContext).workspaceKey);
            } catch {
              workspaceTrust = undefined;
            }
          }
          return { page, blocks: res.blockCount, truncated: res.truncated, text: res.text, readAt, ...(workspaceTrust !== undefined ? { workspaceTrust } : {}) };
        },
        toModelOutput(output) {
          const header = output.text.length === 0 ? `Notion page ${output.page} has no readable text.` : `Notion page ${output.page}:`;
          const suffix = output.truncated ? "\n\n[truncated — the page has more content than shown]" : "";
          const asOf =
            output.text.length > 0 && output.readAt ? `\n\nRead live at ${output.readAt}: the text above is the page's current content, as of that moment.` : "";
          const body = output.text.length === 0 ? header : `${header}\n${output.text}${suffix}${asOf}`;
          return ingestUntrustedModelOutput(body, {
            source: `notion page ${output.page}`,
            ingestion: {
              kind: "notion",
              label: "read_notion_page",
              ...(output.workspaceTrust !== undefined ? { workspaceTrust: output.workspaceTrust } : {}),
            },
          });
        },
});
preRegisterDynamicEntry("read_notion_page", "_single", readNotionPageEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const ok =
        sourceScopedMount(ctx as BindableContext, "notion", () => getConfig().loadDomains()) ||
        notionWorkMount(ctx as BindableContext, () => getConfig().loadDomains());
      if (!ok) return null;
      return readNotionPageEntry;
    },
  },
});
