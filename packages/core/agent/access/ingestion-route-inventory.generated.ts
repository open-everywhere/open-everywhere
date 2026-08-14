export interface IngestionRoute {
  readonly key: string;
  readonly file: string;
  readonly form: "ingestion-property" | "ingestion-const" | "noteIngestionVerdict" | "chatReadIngestion";
  readonly kind: string;
  readonly label: string | null;
  readonly pending: boolean;
}

export const INGESTION_ROUTES: readonly IngestionRoute[] = [
  { key: "packages/core/agent/access/aws-output.ts#aws", file: "packages/core/agent/access/aws-output.ts", form: "ingestion-const", kind: "aws", label: "aws", pending: false },
  { key: "packages/core/agent/access/browser-toolkit.ts#browser_${op}", file: "packages/core/agent/access/browser-toolkit.ts", form: "ingestion-property", kind: "web", label: "browser_${op}", pending: false },
  { key: "packages/core/agent/access/task-result-delta.ts#task_result", file: "packages/core/agent/access/task-result-delta.ts", form: "ingestion-property", kind: "delegation-result", label: "task_result", pending: false },
  { key: "packages/core/agent/access/untrusted-projection.ts#name", file: "packages/core/agent/access/untrusted-projection.ts", form: "ingestion-property", kind: "connector", label: "name", pending: false },
  { key: "packages/core/agent/channels/context-render.ts#context-render", file: "packages/core/agent/channels/context-render.ts", form: "noteIngestionVerdict", kind: "chat-message", label: "context-render", pending: false },
  { key: "packages/core/agent/channels/wake-envelope.ts#wake-envelope:${sourcePlatform}", file: "packages/core/agent/channels/wake-envelope.ts", form: "noteIngestionVerdict", kind: "chat-message", label: "wake-envelope:${sourcePlatform}", pending: false },
  { key: "packages/core/agent/channels/wake-envelope.ts#wake-envelope:handoff", file: "packages/core/agent/channels/wake-envelope.ts", form: "noteIngestionVerdict", kind: "handoff", label: "wake-envelope:handoff", pending: false },
  { key: "packages/core/agent/review/pr-walkthrough.ts#walk_pr:${pr.repo}", file: "packages/core/agent/review/pr-walkthrough.ts", form: "noteIngestionVerdict", kind: "github", label: "walk_pr:${pr.repo}", pending: false },
  { key: "packages/core/agent/routines/events.ts#github-event", file: "packages/core/agent/routines/events.ts", form: "ingestion-property", kind: "routine-event", label: "github-event", pending: false },
  { key: "packages/core/agent/scm/pr-feedback.ts#get_pr_feedback:${d.repo}", file: "packages/core/agent/scm/pr-feedback.ts", form: "ingestion-const", kind: "github", label: "get_pr_feedback:${d.repo}", pending: false },
  { key: "packages/core/agent/tools/describe_image.ts#describe_image", file: "packages/core/agent/tools/describe_image.ts", form: "ingestion-property", kind: "image-description", label: "describe_image", pending: false },
  { key: "packages/core/agent/tools/list_recent_events.ts#list_recent_events", file: "packages/core/agent/tools/list_recent_events.ts", form: "ingestion-property", kind: "webhook", label: "list_recent_events", pending: false },
  { key: "packages/core/agent/tools/read_channel.ts#read_channel:${output.platform}", file: "packages/core/agent/tools/read_channel.ts", form: "chatReadIngestion", kind: "chat-message", label: "read_channel:${output.platform}", pending: false },
  { key: "packages/core/agent/tools/read_file_upload.ts#read_file_upload", file: "packages/core/agent/tools/read_file_upload.ts", form: "ingestion-property", kind: "file-upload", label: "read_file_upload", pending: false },
  { key: "packages/core/agent/tools/read_routine_transcript.ts#read_routine_transcript", file: "packages/core/agent/tools/read_routine_transcript.ts", form: "ingestion-property", kind: "routine-event", label: "read_routine_transcript", pending: false },
  { key: "packages/core/agent/tools/read_thread.ts#read_thread:${output.platform}", file: "packages/core/agent/tools/read_thread.ts", form: "chatReadIngestion", kind: "chat-message", label: "read_thread:${output.platform}", pending: false },
  { key: "packages/core/agent/tools/read_webhook_history.ts#read_webhook_history", file: "packages/core/agent/tools/read_webhook_history.ts", form: "ingestion-property", kind: "webhook", label: "read_webhook_history", pending: false },
  { key: "packages/core/agent/tools/sandbox_tools.ts#<ingestion-property>", file: "packages/core/agent/tools/sandbox_tools.ts", form: "ingestion-property", kind: "skill-declared", label: null, pending: false },
  { key: "packages/core/agent/tools/sandbox_tools.ts#web_fetch", file: "packages/core/agent/tools/sandbox_tools.ts", form: "ingestion-property", kind: "web", label: "web_fetch", pending: false },
  { key: "packages/core/agent/tools/subscribe_pr.ts#subscribe_pr:title", file: "packages/core/agent/tools/subscribe_pr.ts", form: "noteIngestionVerdict", kind: "github", label: "subscribe_pr:title", pending: false },
  { key: "packages/core/agent/webhooks/dispatch.ts#webhook-body", file: "packages/core/agent/webhooks/dispatch.ts", form: "ingestion-property", kind: "webhook", label: "webhook-body", pending: false },
  { key: "packages/core/agent/webhooks/dispatch.ts#webhook-summary", file: "packages/core/agent/webhooks/dispatch.ts", form: "ingestion-property", kind: "webhook", label: "webhook-summary", pending: false },
  { key: "packages/providers/linear/agent/tools/read_linear_issue.ts#read_linear_issue", file: "packages/providers/linear/agent/tools/read_linear_issue.ts", form: "ingestion-property", kind: "linear", label: "read_linear_issue", pending: false },
  { key: "packages/providers/notion/agent/tools/read_notion_comments.ts#read_notion_comments", file: "packages/providers/notion/agent/tools/read_notion_comments.ts", form: "ingestion-property", kind: "notion", label: "read_notion_comments", pending: false },
  { key: "packages/providers/notion/agent/tools/read_notion_page.ts#read_notion_page", file: "packages/providers/notion/agent/tools/read_notion_page.ts", form: "ingestion-property", kind: "notion", label: "read_notion_page", pending: false },
  { key: "packages/providers/slack/agent/channels/slack-events.ts#slack:channel-join-intro", file: "packages/providers/slack/agent/channels/slack-events.ts", form: "noteIngestionVerdict", kind: "chat-message", label: "slack:channel-join-intro", pending: false },
  { key: "packages/providers/slack/agent/tools/read_slack_channel.ts#read_slack_channel", file: "packages/providers/slack/agent/tools/read_slack_channel.ts", form: "chatReadIngestion", kind: "chat-message", label: "read_slack_channel", pending: false },
  { key: "packages/providers/slack/agent/tools/read_slack_thread.ts#read_slack_thread", file: "packages/providers/slack/agent/tools/read_slack_thread.ts", form: "chatReadIngestion", kind: "chat-message", label: "read_slack_thread", pending: false },
];
