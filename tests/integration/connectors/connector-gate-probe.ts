import { setSeatToolsetStubForTest } from "@open-everywhere/core/agent/access/seat-cut.js";

/**
 * The connector gate probe: the agent's OWN connector tool, offered again on a surface where the
 * connector mount withholds it, so a spec can call it there and read the call-time gate's verdict.
 *
 * On eve 1.x a connector mount (`agent/connections/connector-mount.ts`) lists its ops before each
 * model call. A listing that the gate refuses offers no op and writes no audit row, so on a surface
 * where the gate refuses, the model has no connector tool to call at all. A spec asserts that
 * withholding end-to-end (`eve__search` finds no op, nothing dials the vendor). The probe adds the
 * second half: the checks that a CALL runs still refuse on that surface, for the expected reason,
 * and write their own `connector.refused` row. Those checks are the op's approval policy (where the
 * op has one), then `execute`'s `spec.auth(ctx)` and `getToken` with no listing marker. So the
 * call-time checks stand even if a listing let an op through.
 *
 * The probe cannot build that tool itself. The agent runs from its bundled build, so a module that a
 * spec imports is a second instance, with no app config registered and none of the agent's state.
 * So the probe captures the agent's tool object where the mount offers it (for example
 * `notion__sign_in` in a DM), through the seat cut's stub seam (`setSeatToolsetStubForTest`), which
 * receives the tools of each slot as the agent resolved them. It then offers a non-deferred copy of
 * that object under `CONNECTOR_GATE_PROBE`, on a donor slot that every worker holds. Its `execute`,
 * approval policy and `toModelOutput` are the agent's own. The capture needs one earlier step in the
 * same process where the mount offered the tool.
 */
export const CONNECTOR_GATE_PROBE = "it_connector_gate_probe";

const DONOR_SLOT = "agent_version";

export interface ConnectorGateProbe {
  /** True once a step where the mount offered the tool has run. */
  captured(): boolean;
  restore(): void;
}

/** Capture `<connection>__<op>` where the mount offers it, and offer it as `CONNECTOR_GATE_PROBE` on every worker. */
export function installConnectorGateProbe(connection: string, op: string): ConnectorGateProbe {
  const name = `${connection}__${op}`;
  let tool: object | undefined;
  const original = setSeatToolsetStubForTest(undefined);
  setSeatToolsetStubForTest((slug, toolset) => {
    original?.(slug, toolset);
    const offered = toolset[name];
    if (slug === connection && offered !== null && typeof offered === "object") tool = offered;
    if (slug !== DONOR_SLOT || toolset[DONOR_SLOT] === undefined || tool === undefined) return;
    const copy = Object.create(Object.getPrototypeOf(tool) as object | null, Object.getOwnPropertyDescriptors(tool)) as { deferred?: boolean };
    copy.deferred = false;
    toolset[CONNECTOR_GATE_PROBE] = copy;
  });
  return {
    captured: () => tool !== undefined,
    restore: () => {
      setSeatToolsetStubForTest(original);
    },
  };
}
