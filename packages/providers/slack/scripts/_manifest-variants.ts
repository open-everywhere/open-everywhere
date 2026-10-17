import { DEPLOY_HOST_PLACEHOLDER } from "@open-everywhere/core/agent/adapter-api.js";
import { SLACK_APP_NAME_MAX, slackAppManifestTemplate, type SlackAppManifestOptions } from "../agent/app-manifest.js";

export const VARIANT_HOST = "oe.example.com";

export interface ManifestVariant {
  readonly label: string;
  readonly manifest: Record<string, unknown>;
}

const LONGEST_COMMAND = "a".repeat(31);

const FOUR_PROMPTS = Array.from({ length: 4 }, (_, i) => ({
  title: `Prompt ${i + 1}: ${"t".repeat(60)}`,
  message: `Message ${i + 1}: ${"m".repeat(400)}`,
}));

const NAMES: readonly { readonly label: string; readonly opts: SlackAppManifestOptions }[] = [
  { label: "default name", opts: {} },
  { label: "longest explicit name", opts: { appName: "N".repeat(SLACK_APP_NAME_MAX) } },
  { label: "over-long configured name", opts: { agentName: `Configured ${"x".repeat(SLACK_APP_NAME_MAX)}` } },
];
const COMMANDS: readonly { readonly label: string; readonly opts: SlackAppManifestOptions }[] = [
  { label: "default command", opts: {} },
  { label: "longest command", opts: { commandName: LONGEST_COMMAND } },
];
const PROMPTS: readonly { readonly label: string; readonly opts: SlackAppManifestOptions }[] = [
  { label: "no prompts", opts: {} },
  { label: "four prompts", opts: { suggestedPrompts: FOUR_PROMPTS } },
];
const SLACK_AS_YOU: readonly { readonly label: string; readonly opts: SlackAppManifestOptions }[] = [
  { label: "without slackAsYou", opts: {} },
  { label: "with slackAsYou", opts: { personalMcp: true } },
];

export function pastedManifest(template: string): Record<string, unknown> {
  return JSON.parse(template.split(DEPLOY_HOST_PLACEHOLDER).join(VARIANT_HOST)) as Record<string, unknown>;
}

export function manifestVariants(): readonly ManifestVariant[] {
  const out: ManifestVariant[] = [];
  for (const name of NAMES)
    for (const command of COMMANDS)
      for (const prompts of PROMPTS)
        for (const asYou of SLACK_AS_YOU) {
          const opts: SlackAppManifestOptions = { ...name.opts, ...command.opts, ...prompts.opts, ...asYou.opts };
          out.push({
            label: [name.label, command.label, prompts.label, asYou.label].join(", "),
            manifest: pastedManifest(slackAppManifestTemplate(opts)),
          });
        }
  return out;
}
