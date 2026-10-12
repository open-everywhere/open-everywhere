import { getConfig, type AppConfig } from "../access/config.js";

export type WakeArmAnswer = "wake" | "abstain";

export type WakeArmSurface = "slack" | "discord" | "teams" | "github" | "linear" | "notion";

export type WakeArmField = "text" | "channelId" | "authorId";

export interface WakeArmSurfaceDeclaration {
  readonly offers: boolean;
  readonly fields: readonly WakeArmField[];
  readonly note: string;
}

export const WAKE_ARM_SURFACE_CONTRACT: Readonly<Record<WakeArmSurface, WakeArmSurfaceDeclaration>> = Object.freeze({
  slack: Object.freeze({
    offers: true,
    fields: Object.freeze(["text", "channelId", "authorId"]) as readonly WakeArmField[],
    note:
      "The NAME-DROP route only (routeNameDropEvent, slack-events.ts): it stages its gates, so it " +
      "can report that the built-in abstained on the NAME with every other gate passed. 🔴 THAT ROUTE " +
      "IS NOT EVERY SLACK MESSAGE. A domain running the ambient supervisor never reaches it at all " +
      "(slack-front.ts diverts to routeSupervisorEvent), and a domain whose `nameDropWake` flag is " +
      "off — the shipped default — returns before the arm rung. So an arm here is INERT until a " +
      "domain turns `nameDropWake` on with the ambient supervisor off. `text` is the AUTHORED text " +
      "only (ParsedMessageEvent.authoredText, OPE-1374) — quoted content a forward dragged in is not in it.",
  }),
  discord: Object.freeze({
    offers: false,
    fields: Object.freeze([]) as readonly WakeArmField[],
    note:
      "nameDropEligible (discord-gateway.ts) folds the name match into one boolean and reports no " +
      "basis, so this surface cannot tell an abstention from a policy drop. Offering the seam here " +
      "means splitting that function first — its own change, not this seam's.",
  }),
  teams: Object.freeze({
    offers: false,
    fields: Object.freeze([]) as readonly WakeArmField[],
    note:
      "resolveTeamsNameDrop (teams-name-drop.ts, OPE-2444) answers one boolean per message and reports no " +
      "abstention apart from a policy drop — offering the seam means staging its gates first.",
  }),
  github: Object.freeze({ offers: false, fields: Object.freeze([]) as readonly WakeArmField[], note: "No ambient name-drop route at all — there is no abstention to fill." }),
  linear: Object.freeze({ offers: false, fields: Object.freeze([]) as readonly WakeArmField[], note: "No ambient name-drop route at all — there is no abstention to fill." }),
  notion: Object.freeze({ offers: false, fields: Object.freeze([]) as readonly WakeArmField[], note: "No ambient name-drop route at all — there is no abstention to fill." }),
});

let CONTRACT: Readonly<Partial<Record<WakeArmSurface, WakeArmSurfaceDeclaration>>> = WAKE_ARM_SURFACE_CONTRACT;

function surfaceDeclaration(surface: WakeArmSurface): WakeArmSurfaceDeclaration | undefined {
  return CONTRACT[surface];
}

export function _setWakeArmSurfaceContractForTest(
  contract: Readonly<Partial<Record<WakeArmSurface, WakeArmSurfaceDeclaration>>>,
): void {
  CONTRACT = contract;
}

export function _resetWakeArmSurfaceContractForTest(): void {
  CONTRACT = WAKE_ARM_SURFACE_CONTRACT;
}

export const WAKE_ARM_MAX_TEXT_CHARS = 4000;

export interface WakeArmInput {
  readonly surface: WakeArmSurface;
  readonly text: string;
  readonly channelId?: string;
  readonly authorId?: string;
}

export interface WakeArmMessage {
  readonly surface: WakeArmSurface;
  readonly text: string;
  readonly channelId: string;
  readonly authorId?: string;
}

export interface BuiltInWakeAnswer {
  readonly wakes: boolean;
  readonly abstained: boolean;
}

let ARM_TIMEOUT_MS = 8000;

export function wakeArmTimeoutMs(): number {
  return ARM_TIMEOUT_MS;
}

export function _setWakeArmTimeoutMsForTest(ms: number): void {
  ARM_TIMEOUT_MS = ms;
}

export function _resetWakeArmTimeoutMsForTest(): void {
  ARM_TIMEOUT_MS = 8000;
}

const TIMED_OUT = Symbol("wake-arm-timeout");

function registeredWakeArm(): AppConfig["decideWake"] {
  try {
    return getConfig().decideWake;
  } catch {
    return undefined;
  }
}

export function wakeArmOffered(surface: WakeArmSurface): boolean {
  return (surfaceDeclaration(surface)?.offers ?? false) && registeredWakeArm() !== undefined;
}

function projectForSurface(msg: WakeArmMessage, declaration: WakeArmSurfaceDeclaration): WakeArmInput {
  const declared = new Set<WakeArmField>(declaration.fields);
  return {
    surface: msg.surface,
    text: declared.has("text") ? msg.text.slice(0, WAKE_ARM_MAX_TEXT_CHARS) : "",
    channelId: declared.has("channelId") ? msg.channelId : undefined,
    authorId: declared.has("authorId") ? msg.authorId : undefined,
  };
}

export async function wakeAfterArm(builtIn: BuiltInWakeAnswer, msg: WakeArmMessage): Promise<boolean> {
  if (builtIn.wakes) return true;
  if (!builtIn.abstained) return false;
  const declaration = surfaceDeclaration(msg.surface);
  if (declaration === undefined || !declaration.offers) return false;
  const arm = registeredWakeArm();
  if (arm === undefined) return false;
  return (await runArm(arm, projectForSurface(msg, declaration))) === "wake";
}

async function runArm(arm: NonNullable<AppConfig["decideWake"]>, input: WakeArmInput): Promise<WakeArmAnswer> {
  const where = `${input.surface} ${input.channelId ?? "(channel undeclared)"}`;
  let answer: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ARM_TIMEOUT_MS);
    });
    answer = await Promise.race([Promise.resolve(arm(input)), timeout]);
  } catch (err) {
    console.warn(`[open-everywhere:channels] decideWake arm threw for ${where}; kept the built-in answer: ${String(err)}`);
    return "abstain";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (answer === TIMED_OUT) {
    console.warn(`[open-everywhere:channels] decideWake arm exceeded ${ARM_TIMEOUT_MS}ms for ${where}; kept the built-in answer`);
    return "abstain";
  }
  if (answer === undefined || answer === "abstain") return "abstain";
  if (typeof answer !== "string") {
    console.warn(
      `[open-everywhere:channels] decideWake arm returned ${typeof answer} for ${where}, which is not one of "wake" | "abstain"; kept the built-in answer`,
    );
    return "abstain";
  }
  if (answer !== "wake") {
    console.warn(
      `[open-everywhere:channels] decideWake arm returned "${answer}" for ${where}, which is outside "wake" | "abstain"; kept the built-in answer`,
    );
    return "abstain";
  }
  return "wake";
}
