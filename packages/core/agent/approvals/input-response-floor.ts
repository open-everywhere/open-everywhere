import { appendAudit, type AuditInput } from "../audit/audit.js";
import { checkClickerFloor, type ClickerFloorRefusal } from "./clicker-floor.js";

export const INPUT_RESPONSE_DENIED_AUDIT_ACTION = "input_response.denied";

export type InputResponseRefusal = ClickerFloorRefusal | "guest-answerer";

export type InputResponseAdmission =
  | { readonly ok: true; readonly floor: string }
  | { readonly ok: false; readonly reason: InputResponseRefusal; readonly notice: string };

export interface InputResponseScope {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly surfaceKey: string;
  readonly principalId: string;
  readonly responses?: number;
  readonly answererIsGuest?: boolean;
}

export interface InputResponseDeps {
  readonly floor?: typeof checkClickerFloor;
  readonly audit?: (entry: AuditInput) => Promise<void>;
}

export function inputResponseRefusalNotice(reason: InputResponseRefusal): string {
  switch (reason) {
    case "audience-floor":
      return "I didn't take that answer: this channel has people from outside the org. Answer from an internal channel. The question is still open.";
    case "unattested-room":
      return "I didn't take that answer: I couldn't check who is in this conversation. Answer from a room I can check. The question is still open.";
    case "foreign-room":
      return "I didn't take that answer: it didn't come from the room I asked in. The question is still open.";
    case "guest-answerer":
    case "guest-clicker":
      return "I didn't take that answer: I couldn't confirm you are a member of this workspace. A member can answer it. The question is still open.";
  }
}

export async function admitInputResponse(
  scope: InputResponseScope,
  deps: InputResponseDeps = {},
): Promise<InputResponseAdmission> {
  const refuse = async (reason: InputResponseRefusal, floor: string): Promise<InputResponseAdmission> => {
    await (deps.audit ?? appendAudit)({
      org: scope.org,
      platform: scope.platform,
      workspace: scope.workspace,
      ...(scope.surface === undefined ? {} : { surface: scope.surface }),
      principalId: scope.principalId,
      action: INPUT_RESPONSE_DENIED_AUDIT_ACTION,
      detail: { reason, floor, ...(scope.responses === undefined ? {} : { responses: scope.responses }) },
    }).catch(() => undefined);
    return { ok: false, reason, notice: inputResponseRefusalNotice(reason) };
  };

  if (scope.answererIsGuest === true) return refuse("guest-answerer", "guest");

  const verdict = await (deps.floor ?? checkClickerFloor)(scope.surfaceKey, { beneficiaryClicker: false });
  if (!verdict.ok) return refuse(verdict.reason, verdict.floor);
  return { ok: true, floor: verdict.floor };
}
