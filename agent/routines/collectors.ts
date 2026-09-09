import { registerRoutineCollectors, type RoutineCollectorDef } from "@open-everywhere/core/agent/routines/collector.js";
import { registerRoutineGates, type RoutineGateDef } from "@open-everywhere/core/agent/routines/gate.js";

export const ROUTINE_COLLECTORS: readonly RoutineCollectorDef[] = [];

export const ROUTINE_GATES: readonly RoutineGateDef[] = [];

registerRoutineCollectors(ROUTINE_COLLECTORS);
registerRoutineGates(ROUTINE_GATES);
