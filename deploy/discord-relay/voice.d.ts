export interface DesiredVoice {
  readonly meetingId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly deadlineMs: number;
}
export interface VoiceCredentials {
  readonly guildId: string;
  readonly channelId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly token: string;
  readonly endpoint: string;
}
export declare function voiceStatePayload(guildId: string, channelId: string | null): { op: 4; d: { guild_id: string; channel_id: string | null; self_mute: boolean; self_deaf: boolean } };
export declare function parseSyncAnswer(raw: unknown): { voice: DesiredVoice[]; nextPollMs: number | undefined };
export declare function nextDelay(nextPollMs: number | undefined): number;
export declare function planVoice(
  desired: readonly DesiredVoice[],
  held: ReadonlyMap<string, { readonly guildId: string; readonly channelId: string }>,
  now: number,
): { join: DesiredVoice[]; leave: string[] };
export declare function channelRefusal(channel: { readonly type: number } | undefined | null, canConnect: boolean): string | undefined;
export declare function credentialsFrom(
  state: Record<string, unknown> | undefined,
  server: Record<string, unknown> | undefined,
  expect: { readonly guildId: string; readonly channelId: string },
): VoiceCredentials | undefined;
export declare const JOIN_TIMEOUT_MS: number;
export declare function voiceSyncEnvelope(relayId: string, sessions: readonly unknown[]): { source: "discord-gateway-relay"; event: "VOICE_SYNC"; voice: { relayId: string; sessions: readonly unknown[] } };
export declare function heldReport(
  h: { since: number; ready?: boolean; failed?: string },
  credentials: VoiceCredentials | undefined,
  now: number,
): { credentials?: VoiceCredentials; failed?: string };
