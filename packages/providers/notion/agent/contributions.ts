export const CONTRIBUTIONS = {
  schemaVersion: 1,
  package: "@open-everywhere/provider-notion",
  register: "agent/register.js#registerNotionProvider",
  contributions: [
    { kind: "tool", name: "read_notion_comments", module: "agent/tools/read_notion_comments.js", summary: "Read the comments / inline discussions on a Notion page (this doc, or another page shared with the integration)." },
    { kind: "tool", name: "read_notion_page", module: "agent/tools/read_notion_page.js", summary: "Read the text of a Notion page (this doc, or another page shared with the integration)." },

    { kind: "channel", name: "notion", module: "agent/channels/notion.js", summary: "The Notion comment surface — an AMBIENT-JUDGED conversational channel." },
  ],
} as const;
