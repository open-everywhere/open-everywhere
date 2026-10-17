import { inlineForReview } from "./review-surface.js";
import { plainValue } from "./plain-text.js";
import { friendlyWhen } from "../channels/person-text.js";
import { registerActionKind } from "./actions.js";
import { grantAct, handBack } from "../personal-browser/lifecycle.js";
import { getPersonalBrowserState } from "../personal-browser/store.js";
import { findDraft, proposeDraft } from "../personal-browser/teach.js";
import type { ActionKind } from "./types.js";

export interface BrowserActArgs {
  readonly org: string;
  readonly person: string;
  readonly principalId: string;
  readonly host: string;
  readonly minutes: number;
  readonly reason?: string;
}

export interface BrowserHandbackArgs {
  readonly org: string;
  readonly person: string;
  readonly principalId: string;
  readonly reason: string;
  readonly teach?: string;
}

function ownerOnly(principalId: string, decidedBy: string): void {
  if (decidedBy !== principalId) throw new Error("only the person whose browser this is can decide this, by their own click — an automatic approval (a config rule, the judge or a bypass) does not count");
}

export function browserActSummary(args: BrowserActArgs): string[] {
  return [
    `Let me click, type and choose options on ${inlineForReview(args.host)} in your own browser, for the next ${args.minutes} minutes.`,
    "You are signed in there, so I can submit forms and change things in your account on that site.",
    "I can't type into password, one-time-code or card fields: you type those yourself after you take the controls.",
    "Every action I take writes an audit row with the site and the kind of action, never what I typed.",
    ...(args.reason ? [`Why: ${inlineForReview(args.reason)}`] : []),
  ];
}

const browserAct: ActionKind<BrowserActArgs> = {
  kind: "browser.personal.act",
  policy: "member",
  proseArgs: ["reason"],
  summarize: browserActSummary,
  plainSummary(args) {
    return `Let the agent click and type on ${plainValue(args.host)} in your own browser for ${args.minutes} minutes`;
  },
  async execute(args, decidedBy) {
    ownerOnly(args.principalId, decidedBy);
    const until = await grantAct(args.org, args.person, args.host, args.minutes, decidedBy);
    return `the agent may click and type on ${args.host} in your browser until ${friendlyWhen(new Date(until).toISOString())}`;
  },
};

export function browserHandbackSummary(args: BrowserHandbackArgs): string[] {
  return [
    `You have the controls of your browser: ${inlineForReview(args.reason)}`,
    "Open it from the link I sent you in this DM. I'm not touching the browser while you have the controls.",
    ...(args.teach !== undefined
      ? [
          `I'm recording your demonstration for the draft skill ${inlineForReview(args.teach)}: the pages, and the links, buttons and fields you use. I never record the text you type into a field, but a link or an option you pick can repeat it.`,
          "When you're done, approve this card. That ends the recording and saves the draft. Nothing runs it until you ask.",
        ]
      : ["When you're done, approve this card to give the controls back to me, and I'll carry on from the page you left."]),
  ];
}

const browserHandback: ActionKind<BrowserHandbackArgs> = {
  kind: "browser.personal.handback",
  policy: "member",
  proseArgs: ["reason"],
  summarize: browserHandbackSummary,
  plainSummary() {
    return "Give the controls of your browser back to the agent";
  },
  async execute(args, decidedBy) {
    ownerOnly(args.principalId, decidedBy);
    const changed = await handBack(args.org, args.person, "card");
    if (args.teach !== undefined) {
      const found = (await getPersonalBrowserState(args.org, args.person))?.state;
      const draft = found === undefined ? undefined : findDraft(found, args.teach);
      if (changed && draft !== undefined) {
        return `the controls are back with the agent, and it saved your demonstration as the paused draft "${draft.name}" (${draft.steps.length} steps${draft.capped ? ", the recording hit its cap" : ""}). Ask it to show, rehearse or propose the draft`;
      }
      if (changed) return "the controls are back with the agent, but the recording could not be saved (the browser may have restarted) — nothing was drafted";
    }
    return changed ? "the controls are back with the agent; it carries on from the page you left" : "the agent already had the controls";
  },
};

export interface BrowserProposeArgs {
  readonly org: string;
  readonly person: string;
  readonly principalId: string;
  readonly name: string;
  readonly steps: number;
  readonly gaps: number;
}

export function browserProposeSummary(args: BrowserProposeArgs): string[] {
  return [
    `Open a pull request on this deployment's config repo that proposes your taught draft ${inlineForReview(args.name)} as a skill (${args.steps} steps, ${args.gaps} gaps to fill).`,
    "The pull request shows the draft to the config repo's readers: the labels of the links, buttons and fields you used, and the page paths. A path can carry an id or a token, and a label can repeat text you typed. Read the draft first.",
    "Merging the pull request is what arms the skill. Nothing changes until a person merges it.",
  ];
}

const browserPropose: ActionKind<BrowserProposeArgs> = {
  kind: "browser.personal.propose",
  policy: "member",
  summarize: browserProposeSummary,
  plainSummary(args) {
    return `Propose your taught draft "${plainValue(args.name)}" as a skill, by pull request`;
  },
  async execute(args, decidedBy) {
    ownerOnly(args.principalId, decidedBy);
    const found = (await getPersonalBrowserState(args.org, args.person))?.state;
    const draft = found === undefined ? undefined : findDraft(found, args.name);
    if (found === undefined || draft === undefined) return `the taught draft "${args.name}" is gone (it was discarded, or the browser was forgotten), so nothing was proposed`;
    const r = await proposeDraft(found, draft);
    if (r.opened) return `opened a pull request proposing "${draft.name}" as a skill: ${r.url ?? `#${r.number ?? "?"}`}. Merging it is what arms the skill — fill the marked gaps first`;
    if (r.dryRun === true) return `this deployment runs config-repo writes as a dry run, so the proposal of "${draft.name}" was recorded and no pull request was opened`;
    return `no pull request was opened: ${r.skipped ?? "the proposal was skipped"}. The draft stays in your browser's record`;
  },
};

registerActionKind(browserAct);
registerActionKind(browserHandback);
registerActionKind(browserPropose);
