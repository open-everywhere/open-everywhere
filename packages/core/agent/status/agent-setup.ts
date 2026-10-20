import { personWords } from "../channels/friendly-ids.js";
import { parsePrincipalKey } from "../identity/principal-key.js";
import { surfaceDisplayName } from "../instructions/seat-prompt.js";

export type SetupVerdict = "yes" | "no" | "unknown";

export type AskerStanding =
  | { readonly kind: "org-admin" }
  | { readonly kind: "domain-admin"; readonly domain: string }
  | { readonly kind: "member" }
  | { readonly kind: "unknown" };

export interface AgentSetupFacts {
  readonly asker?: string;
  readonly askerPlatform?: string;
  readonly standing: AskerStanding;
  readonly adminElsewhere?: readonly string[];
  readonly domainAdminsExist?: boolean;
  readonly orgAdmins: readonly string[];
  readonly roomDomain?: { readonly name: string; readonly title?: string; readonly admins: readonly string[] };
  readonly surfaces: readonly { readonly platform: string; readonly installed: SetupVerdict }[];
  readonly connectors: readonly string[];
  readonly repos: readonly string[];
  readonly github: {
    readonly mode: "app" | "token";
    readonly appConfigured: boolean;
    readonly appSlug?: string;
    readonly tokenSet: SetupVerdict;
  };
  readonly configChanges: {
    readonly repo?: string;
    readonly adminChannel: boolean;
    readonly appInstalled: SetupVerdict;
    readonly dryRun?: boolean;
  };
}

export interface SetupGap {
  readonly what: string;
  readonly step: string;
}

export interface AgentSetupAnswer {
  readonly you: string;
  readonly admins: string;
  readonly connectedTo: readonly string[];
  readonly adminCanDoNow: readonly string[];
  readonly notYet: readonly SetupGap[];
  readonly forOperator: readonly string[];
}

export const SETUP_JARGON: readonly RegExp[] = [
  /\bruntime[- ]state\b/i,
  /\bauthority\b/i,
  /\bcapability bindings?\b/i,
  /\bbundles?\b/i,
  /\bdomain declarations?\b/i,
  /\blive grants?\b/i,
  /\bgrants?\b/i,
  /\broster\b/i,
  /\bprincipal\b/i,
  /\bconfig repo\b/i,
  /\bgovernance\b/i,
];

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function rosterWords(keys: readonly string[], f: AgentSetupFacts): string[] {
  const named: string[] = [];
  const unnamed = new Map<string, number>();
  let you = false;
  for (const key of keys) {
    const parsed = parsePrincipalKey(key);
    const platform = parsed?.platform ?? f.askerPlatform;
    const words =
      platform !== undefined && platform === f.askerPlatform
        ? personWords({ id: key, platform, ...(f.asker !== undefined ? { reader: f.asker } : {}) })
        : "someone";
    if (words === "you") you = true;
    else if (words !== "someone") named.push(words);
    else unnamed.set(platform ?? "", (unnamed.get(platform ?? "") ?? 0) + 1);
  }
  for (const [platform, count] of unnamed) {
    const people = count === 1 ? "one person" : `${count} people`;
    named.push(platform ? `${people} on ${surfaceDisplayName(platform)}` : people);
  }
  return you ? [...named, "you"] : named;
}

function verbFor(list: readonly string[]): "is" | "are" {
  return list.length === 1 && list[0] !== "you" && !/^\d+ people\b/.test(list[0]!) ? "is" : "are";
}

function domainWords(d: { readonly name: string; readonly title?: string }): string {
  return d.title?.trim() ? d.title.trim() : d.name;
}

function youSentence(f: AgentSetupFacts, org: readonly string[], room: readonly string[]): string {
  switch (f.standing.kind) {
    case "org-admin":
      return "You're an admin.";
    case "domain-admin":
      return `You're an admin for ${f.roomDomain !== undefined && f.roomDomain.name === f.standing.domain ? domainWords(f.roomDomain) : f.standing.domain}.`;
    case "unknown":
      return "I can't tell who sent this message, so I can't say whether you're an admin. Ask me again in a message of your own.";
    case "member": {
      const elsewhere = f.adminElsewhere ?? [];
      if (elsewhere.length > 0) return `You're not an admin here. You're an admin for ${listWords([...elsewhere])}.`;
      if (org.length === 0 && room.length > 0 && f.roomDomain !== undefined) {
        return `You're not an admin here. ${listWords(room)} ${verbFor(room) === "is" ? "is the admin" : "are the admins"} for ${domainWords(f.roomDomain)}.`;
      }
      if (org.length === 0 && f.domainAdminsExist === true) return "You're not an admin here. No one is an admin everywhere yet.";
      if (org.length === 0) return "You're not an admin, and no admins are set up yet.";
      return `You're not an admin. ${listWords(org)} ${verbFor(org)}.`;
    }
  }
}

function adminsSentence(f: AgentSetupFacts, org: readonly string[], room: readonly string[]): string {
  const parts: string[] = [];
  const roomHasAdmins = f.roomDomain !== undefined && room.length > 0;
  if (org.length === 0 && roomHasAdmins) {
    parts.push("No one is an admin everywhere yet.");
  } else if (org.length === 0 && f.domainAdminsExist === true) {
    parts.push("No one is an admin everywhere yet. Some teams have their own admins.");
  } else if (org.length === 0) {
    parts.push("No admins are set up yet. Whoever runs this deployment adds the first one.");
  } else {
    const single = org.length === 1 && !/^\d+ people\b/.test(org[0]!);
    parts.push(`${single ? "The admin is" : "The admins are"} ${listWords(org)}.`);
  }
  if (f.roomDomain !== undefined && room.length > 0) {
    const tail = verbFor(room) === "is" ? "is an admin" : room.length === 1 && room[0] === "you" ? "are an admin" : "are admins";
    parts.push(`For ${domainWords(f.roomDomain)}, ${listWords(room)} ${tail}${org.length > 0 ? " as well" : ""}.`);
  }
  return parts.join(" ");
}

function connectedLines(f: AgentSetupFacts, isAdmin: boolean): string[] {
  const lines: string[] = [];
  for (const s of f.surfaces) {
    const name = surfaceDisplayName(s.platform);
    lines.push(s.installed === "yes" ? `${name}: installed` : s.installed === "no" ? `${name}: not installed yet` : `${name}: set up, but I can't confirm it is installed`);
  }
  if (f.github.mode === "token") {
    lines.push(
      f.github.tokenSet === "yes"
        ? "GitHub: connected with a personal access token, not the app"
        : f.github.tokenSet === "no"
          ? "GitHub: not connected"
          : "GitHub: set up for a personal access token, but I can't confirm the token is set",
    );
  } else if (f.github.appConfigured) {
    const owner = repoOwner(f.configChanges.repo);
    const here = owner !== undefined && f.configChanges.appInstalled === "yes";
    lines.push(here && isAdmin ? `GitHub: the app is installed for ${owner}` : "GitHub: the app is set up");
  } else {
    lines.push("GitHub: not connected");
  }
  const others = f.connectors.filter((c) => c !== "github").map((c) => surfaceDisplayName(c));
  if (others.length > 0) lines.push(`Also connected here: ${listWords(others)}`);
  if (f.repos.length > 0) lines.push(`Repositories I can work on here: ${listWords([...f.repos])}`);
  return lines;
}

function repoOwner(repo: string | undefined): string | undefined {
  if (repo === undefined) return undefined;
  const i = repo.indexOf("/");
  return i > 0 && i < repo.length - 1 ? repo.slice(0, i) : undefined;
}

const RUNTIME_CONTROLS: readonly string[] = [
  "approve or decline the cards I post",
  "raise or clear a spending limit",
  "stop everything I'm doing at once, and start me again",
  "cut off a connected service at once",
];

const DOMAIN_CONTROLS: readonly string[] = [
  "approve or decline the cards I post in this domain's rooms",
  "raise or clear a spending limit for one of this domain's rooms",
  "stop everything I'm doing at once (starting me again needs an org admin)",
  "cut off a connected service at once",
];

const CONFIG_CHANGES =
  "change my setup from chat: let a room use a service or a repository, add a new service for me to use, set up an agent for a channel, or let another system send me events. Each one starts as a card and becomes a pull request that an admin merges";

function configGaps(f: AgentSetupFacts, repoWords?: string): { ready: boolean; gaps: SetupGap[]; operator: string[] } {
  const c = f.configChanges;
  const gaps: SetupGap[] = [];
  const operator: string[] = [];
  if (c.repo === undefined || !c.adminChannel) {
    gaps.push({
      what: "Changing my setup from chat is off.",
      step: "Whoever runs this deployment names my own repository and an admin channel in its settings, then deploys.",
    });
    if (c.repo === undefined) operator.push("accessRequests.configRepo (agent/settings/settings.ts): this deployment's own repository, as owner/repo.");
    if (!c.adminChannel) operator.push("accessRequests.adminChannel (agent/settings/settings.ts): the channel that hears about each pull request.");
    return { ready: false, gaps, operator };
  }
  const owner = repoOwner(c.repo);
  if (owner === undefined) {
    gaps.push({ what: "Changing my setup from chat is off.", step: "Whoever runs this deployment sets my own repository as owner/name, then deploys." });
    operator.push("accessRequests.configRepo must be owner/repo.");
    return { ready: false, gaps, operator };
  }
  const repo = repoWords ?? c.repo!;
  const ownerWords = repoWords !== undefined ? "its owner" : owner;
  if (c.dryRun === true) {
    gaps.push({
      what: "Changing my setup from chat is in test mode: a card is checked, but no pull request opens.",
      step: "Whoever runs this deployment turns test mode off, then deploys.",
    });
    operator.push("dryRun: false in agent/access/access-requests.ts.");
    return { ready: false, gaps, operator };
  }
  if (f.github.mode === "token") {
    if (f.github.tokenSet === "no") {
      gaps.push({
        what: "Changing my setup from chat needs GitHub, and I'm not connected to it.",
        step: `Whoever runs this deployment adds a personal access token that can change ${repo}.`,
      });
      operator.push("GITHUB_TOKEN: a fine-grained personal access token for this deployment's own repository, stored with `oe secret set GITHUB_TOKEN`.");
      return { ready: false, gaps, operator };
    }
    if (f.github.tokenSet === "unknown") {
      gaps.push({
        what: "I can't confirm a personal access token is set, which changing my setup from chat needs.",
        step: `Whoever runs this deployment checks that a personal access token that can change ${repo} is stored.`,
      });
    }
    operator.push('To move to the GitHub app: create it with the ops tool surface_app_create (variant "source-control" keeps what you have now), push the names it wrote to .env.local to the deployment\'s environment, set github.auth to "app" in agent/settings/settings.ts and redeploy, then install the app on your repositories. Nothing else changes.');
    operator.push('The app brings its own GITHUB_WEBHOOK_SECRET. If a repository webhook feeds your routines, then with variant "source-control", give it the new secret. With "full", delete it, or each event reaches your routines twice.');
    return { ready: true, gaps, operator };
  }
  if (!f.github.appConfigured) {
    gaps.push({
      what: `Changing my setup from chat needs GitHub, and I'm not connected to it.`,
      step: `Whoever runs this deployment sets up the GitHub app and installs it on ${repo}.`,
    });
    operator.push("The GitHub app: the github.appId and github.appSlug settings in agent/settings/settings.ts, and its private key as the operator secret GITHUB_APP_PRIVATE_KEY (`oe secret set GITHUB_APP_PRIVATE_KEY`).");
    if (f.github.tokenSet === "yes") operator.push('GITHUB_TOKEN is set but not used, because this deployment signs in with the GitHub app. To use the token instead, set github.auth to "token" in agent/settings/settings.ts.');
    return { ready: false, gaps, operator };
  }
  if (c.appInstalled !== "yes") {
    const page = f.github.appSlug !== undefined ? ` Its install page is https://github.com/apps/${f.github.appSlug}/installations/new.` : "";
    gaps.push({
      what:
        c.appInstalled === "no"
          ? `Changing my setup from chat needs the GitHub app on ${repo}, and I can't find it installed for ${ownerWords}.`
          : `I can't confirm the GitHub app is installed on ${repo}, which changing my setup from chat needs.`,
      step: `Install the GitHub app on ${repo}.${page}`,
    });
    return { ready: c.appInstalled === "unknown", gaps, operator };
  }
  return { ready: true, gaps, operator };
}

export function renderAgentSetup(f: AgentSetupFacts): AgentSetupAnswer {
  const org = rosterWords(f.orgAdmins, f);
  const room = f.roomDomain !== undefined ? rosterWords(f.roomDomain.admins.filter((k) => !f.orgAdmins.includes(k)), f) : [];
  const isAdmin = f.standing.kind === "org-admin" || f.standing.kind === "domain-admin";
  const config = configGaps(f);
  const controls = f.standing.kind === "org-admin" ? RUNTIME_CONTROLS : DOMAIN_CONTROLS;
  const adminCanDoNow = [...controls, ...(config.ready ? [CONFIG_CHANGES] : [])];
  return {
    you: youSentence(f, org, room),
    admins: adminsSentence(f, org, room),
    connectedTo: connectedLines(f, isAdmin),
    adminCanDoNow: isAdmin ? adminCanDoNow : ["Changing my setup or my limits is something an admin does. Ask one of them."],
    notYet: isAdmin ? config.gaps : [],
    forOperator: isAdmin ? config.operator : [],
  };
}

function seatRosterLine(key: string): string {
  const parsed = parsePrincipalKey(key);
  if (parsed === undefined) return "";
  const platform = surfaceDisplayName(parsed.platform);
  const mention = personWords({ id: key, platform: parsed.platform });
  const named = mention !== "someone" ? `${mention}, ` : "";
  return `${named}\`author-id\` ${parsed.id} on ${platform}`;
}

export function renderSeatSetupSection(f: AgentSetupFacts): string {
  const org = f.orgAdmins.map(seatRosterLine).filter((l) => l.length > 0);
  const room = f.roomDomain !== undefined ? f.roomDomain.admins.filter((k) => !f.orgAdmins.includes(k)).map(seatRosterLine).filter((l) => l.length > 0) : [];
  const lines: string[] = ["### Your admins and your setup", ""];
  if (org.length === 0 && f.roomDomain !== undefined && room.length > 0) {
    lines.push("No one is an admin everywhere yet.");
  } else if (org.length === 0 && f.domainAdminsExist === true) {
    lines.push("No one is an admin everywhere yet. Some teams have their own admins.");
  } else if (org.length === 0) {
    lines.push("No admins are set up yet. Whoever runs this deployment adds the first one.");
  } else {
    lines.push("Your admins, everywhere:", ...org.map((l) => `- ${l}`));
  }
  const roomTitle = f.roomDomain !== undefined ? domainWords(f.roomDomain) : undefined;
  if (roomTitle !== undefined && room.length > 0) {
    lines.push("", `Admins for ${roomTitle} only:`, ...room.map((l) => `- ${l}`));
  }
  lines.push(
    "",
    "This is the list every admin check uses. When someone asks whether they are an admin, or who your " +
      "admins are, answer from it in one message. Match the message's `author-id`, on the same platform:",
    ...(org.length > 0 ? [`- on the "everywhere" list: "You're an admin."`] : []),
    ...(roomTitle !== undefined && room.length > 0 ? [`- on the "${roomTitle} only" list: "You're an admin for ${roomTitle}."`] : []),
    `- anyone else: "You're not an admin here." Then name the admins. They may still be an admin elsewhere, which a worker's \`agent_version\` read says.`,
    `- no \`author-id\`, or several people in the one wake: "I can't tell who sent this, so I can't say whether you're an admin." Never guess "not an admin".`,
    "Name an admin by the mention, never by the id. Never look for it in your memory, and never call it a team decision.",
  );
  const config = configGaps(f, "my own repository");
  const github =
    f.github.mode === "token"
      ? f.github.tokenSet === "yes"
        ? "connected with a personal access token"
        : f.github.tokenSet === "no"
          ? "not connected"
          : "set up for a personal access token, and a worker's `agent_version` read says whether it is set"
      : f.github.appConfigured
        ? "the GitHub app is set up"
        : "not connected";
  lines.push("", `GitHub: ${github}.`);
  if (config.ready && config.gaps.length === 0) {
    lines.push(
      "Changing your setup from chat is ready. An admin can ask for it: a room's access to a service or a repository, a new service, an agent for a channel, or another system sending you events. Each one starts as a card and becomes a pull request on your own repository that an admin merges.",
    );
  } else if (config.ready) {
    lines.push("Changing your setup from chat: I can't confirm from here whether the GitHub app is installed on my own repository. A worker checks it with `agent_version`.");
  } else {
    for (const g of config.gaps) lines.push(`Not ready yet: ${g.what} The one step: ${g.step}`);
    lines.push("Say the step to an admin. Tell anyone else that an admin can set it up.");
  }
  lines.push(
    "",
    "For the full read for one person (whether they are an admin of another domain, each chat app, " +
      "every gap, the repository's name), a worker reads the `setup` part of `agent_version`.",
  );
  return lines.join("\n");
}
