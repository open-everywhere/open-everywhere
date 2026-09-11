export const GIT_BROKER_HOSTS = ["github.com", "codeload.github.com"] as const;

export const RESERVED_BROKER_HOST_REASON =
  `that host is RESERVED by the git read-broker (scm/broker.ts), which replaces its egress rules mid-turn with an ` +
  `installation token, so the credential and the verb narrowing on it would be silently displaced the moment ` +
  `\`checkout_repo\` runs. The reservation is unconditional — it does not depend on whether the broker is configured. ` +
  `One credential per host per session: claim a host the broker does not replace (\`api.github.com\` is not reserved).`;
