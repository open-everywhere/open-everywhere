import type { GrantRoomNotice } from "./credential-grant-broker.js";

const CORE_REGISTRANT = "core:access/credential-grant-notice";

interface RoomNoticeRegistration {
  readonly notice: GrantRoomNotice;
  readonly registrant: string;
}

let registration: RoomNoticeRegistration | undefined;

let coreRegistered = false;

export class GrantRoomNoticeAlreadyRegisteredError extends Error {
  readonly registrant: string;

  constructor(registrant: string) {
    super(
      `a grant room-notice arm is already registered (by ${registrant}). ` +
        `The port is first-write-wins: it refuses a replacement, because a replaced arm stops the ` +
        `host-authored "acting as <owner>" disclosure reaching the room while granted calls keep running.`,
    );
    this.name = "GrantRoomNoticeAlreadyRegisteredError";
    this.registrant = registrant;
  }
}

export function registerGrantRoomNotice(notice: GrantRoomNotice, registrant: string): void {
  if (registrant === CORE_REGISTRANT) {
    throw new Error(
      `"${CORE_REGISTRANT}" is reserved for core's own boot path and cannot be passed as a registrant. ` +
        `Name the module that is registering, so the refusal message names it too.`,
    );
  }
  setRoomNotice(notice, registrant);
}

function setRoomNotice(notice: GrantRoomNotice, registrant: string): void {
  if (registration !== undefined) throw new GrantRoomNoticeAlreadyRegisteredError(registration.registrant);
  registration = { notice, registrant };
}

export function foreignGrantRoomNoticeRegistrant(): string | undefined {
  if (registration === undefined || coreRegistered) return undefined;
  return registration.registrant;
}

export function grantRoomNotice(): GrantRoomNotice | undefined {
  return registration?.notice;
}

export function registerCoreGrantRoomNotice(notice: GrantRoomNotice): void {
  if (coreRegistered) return;
  setRoomNotice(notice, CORE_REGISTRANT);
  coreRegistered = true;
}

export function _resetGrantRoomNoticeForTest(): void {
  registration = undefined;
  coreRegistered = false;
}
