export const CHECK_IN_START_MS = 60_000;

export const CHECK_IN_CAP_MS = 5 * 60_000;

const MINUTE_MS = 60_000;

export const CHECK_IN_DOCTRINE =
  `Self-check-in on in-flight work (waiting on a spawned worker, a review, a build): arm the FIRST ` +
  `check ~${CHECK_IN_START_MS / MINUTE_MS} min out, and if you re-check, BACK OFF each time up to a ` +
  `hard cap of ~${CHECK_IN_CAP_MS / MINUTE_MS} min — never tighter — so a long wait doesn't become a ` +
  `busy-loop of check-ins. Each fire, refresh the status first and only post again if it finished, ` +
  `stalled, or needs input; when the work is done, stop re-arming.`;
