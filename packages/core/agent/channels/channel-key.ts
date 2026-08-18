export const CHANNEL_KEY_PREFIX = "ch_";

export interface ChannelAddress {
  readonly platform: string;
  readonly container: string;
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function encodeChannelKey(platform: string, container: string): string {
  if (!container) return "";
  if (!platform) return container;
  return `${CHANNEL_KEY_PREFIX}${b64url(`${platform}:${container}`)}`;
}

export function decodeChannelKey(key: string): ChannelAddress | null {
  if (!key.startsWith(CHANNEL_KEY_PREFIX)) return null;
  const body = key.slice(CHANNEL_KEY_PREFIX.length);
  if (!body || !/^[A-Za-z0-9_-]+$/u.test(body)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(body.replace(/-/gu, "+").replace(/_/gu, "/"), "base64").toString("utf8");
  } catch {
    return null;
  }
  if (b64url(decoded) !== body) return null;
  const sep = decoded.indexOf(":");
  if (sep <= 0) return null;
  const platform = decoded.slice(0, sep);
  const container = decoded.slice(sep + 1);
  if (!container) return null;
  return { platform, container };
}

export function isChannelKey(s: string): boolean {
  return decodeChannelKey(s) !== null;
}

export function containerIdForPlatform(input: string, platform: string): string {
  const decoded = decodeChannelKey(input);
  if (!decoded) return input;
  if (decoded.platform !== platform) {
    throw new Error(`read: that channel key names a ${decoded.platform} channel, and this tool reads ${platform}.`);
  }
  return decoded.container;
}
