export const OE_ONESHOT_AGENT_ENV = "OE_ONESHOT_AGENT";

export function oneshotAgentEnabled(): boolean {
  const raw = process.env[OE_ONESHOT_AGENT_ENV];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "off" && v !== "no";
}
