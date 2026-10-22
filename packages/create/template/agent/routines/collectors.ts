import { registerRoutineCollectors, type RoutineCollectorDef } from "@open-everywhere/core/agent/routines/collector.js";
import { registerRoutineGates, type RoutineGateDef } from "@open-everywhere/core/agent/routines/gate.js";
import { registerPersonalWatch, type PersonalWatchDecl } from "@open-everywhere/core/agent/personal-watch/watch.js";
import { registerPersonalTriage, type PersonalTriageDecl } from "@open-everywhere/core/agent/personal-watch/triage.js";

export const ROUTINE_COLLECTORS: readonly RoutineCollectorDef[] = [];

export const ROUTINE_GATES: readonly RoutineGateDef[] = [];

export const PERSONAL_WATCH: PersonalWatchDecl = { sources: [] };

export const PERSONAL_TRIAGE: PersonalTriageDecl = { sources: [] };

registerRoutineCollectors(ROUTINE_COLLECTORS);
registerRoutineGates(ROUTINE_GATES);
registerPersonalWatch(PERSONAL_WATCH);
registerPersonalTriage(PERSONAL_TRIAGE);
