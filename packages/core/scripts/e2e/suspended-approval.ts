export interface SuspendedMessageAnchor {
  readonly platform: string;
  readonly surfaceKey: string;
  readonly vendorTs: string;
}

export function slackVendorTimestamp(ts: string): string | undefined {
  const match = /^(\d+)\.(\d{1,6})$/.exec(ts);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  const fraction = Number(`0.${match[2]}`);
  if (!Number.isFinite(seconds) || !Number.isFinite(fraction)) return undefined;
  const date = new Date(Math.round(seconds * 1000 + fraction * 1000));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
