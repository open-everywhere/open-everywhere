import type { GrantBorrowTransport } from "./credential-grant-broker.js";

const CORE_REGISTRANT = "core:connections/grant-mcp-transport";

interface BorrowRegistration {
  readonly registrant: string;
  readonly transport: GrantBorrowTransport;
}

const BORROW_TRANSPORTS = new Map<string, BorrowRegistration>();

const CORE_REGISTERED = new Set<string>();

export class GrantBorrowTransportAlreadyRegisteredError extends Error {
  readonly connector: string;
  readonly registrant: string;

  constructor(connector: string, registrant: string) {
    super(
      `a grant borrow transport is already registered for connector "${connector}" (by ${registrant}). ` +
        `The registry is first-write-wins: it refuses a replacement, because a replaced transport spends ` +
        `the owner's credential outside the MCP call fence.`,
    );
    this.connector = connector;
    this.name = "GrantBorrowTransportAlreadyRegisteredError";
    this.registrant = registrant;
  }
}

export function registerGrantBorrowTransport(connector: string, transport: GrantBorrowTransport, registrant: string): void {
  if (registrant === CORE_REGISTRANT) {
    throw new Error(
      `"${CORE_REGISTRANT}" is reserved for core's own boot path and cannot be passed as a registrant. ` +
        `Name the module that is registering, so the refusal message names it too.`,
    );
  }
  setBorrowTransport(connector, transport, registrant);
}

function setBorrowTransport(connector: string, transport: GrantBorrowTransport, registrant: string): void {
  const held = BORROW_TRANSPORTS.get(connector);
  if (held !== undefined) throw new GrantBorrowTransportAlreadyRegisteredError(connector, held.registrant);
  BORROW_TRANSPORTS.set(connector, { registrant, transport });
}

export function foreignGrantBorrowRegistrant(connector: string): string | undefined {
  const held = BORROW_TRANSPORTS.get(connector);
  if (held === undefined || CORE_REGISTERED.has(connector)) return undefined;
  return held.registrant;
}

export function grantBorrowTransport(connector: string): GrantBorrowTransport | undefined {
  return BORROW_TRANSPORTS.get(connector)?.transport;
}

export function registerCoreGrantBorrowTransport(connector: string, transport: GrantBorrowTransport): void {
  if (CORE_REGISTERED.has(connector)) return;
  setBorrowTransport(connector, transport, CORE_REGISTRANT);
  CORE_REGISTERED.add(connector);
}

export function _resetGrantBorrowTransportsForTest(): void {
  BORROW_TRANSPORTS.clear();
  CORE_REGISTERED.clear();
}
