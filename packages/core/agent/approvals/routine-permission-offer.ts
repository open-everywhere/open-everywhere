export interface RoutinePermissionCardOffer {
  readonly org: string;
  readonly declaration: string;
  readonly grantKey: string;
  readonly scopeKey: string;
  readonly domain?: string | null;
  readonly requestedBy: string;
  readonly tainted: boolean;
  readonly waitBudgetMs: number;
}

export interface RoutinePermissionCardResult {
  readonly clause: string;
}

export type RoutinePermissionCardOfferer = (offer: RoutinePermissionCardOffer) => Promise<RoutinePermissionCardResult>;

let registered: RoutinePermissionCardOfferer | undefined;

export function registerRoutinePermissionCardOfferer(offerer: RoutinePermissionCardOfferer): void {
  registered = offerer;
}

export function routinePermissionCardOffererRegistered(): boolean {
  return registered !== undefined;
}

export async function offerRoutinePermissionCardFor(offer: RoutinePermissionCardOffer): Promise<RoutinePermissionCardResult> {
  if (registered === undefined) return { clause: "" };
  try {
    return await registered(offer);
  } catch {
    return { clause: "" };
  }
}
