import type { BlockList } from "node:net";

export function parseAllow(raw: string): string[];
export function bareHost(host: string): string;
export function hostAllowed(host: string, allow: readonly string[]): boolean;
export function internalBlockList(interfaceAddresses?: readonly string[]): BlockList;
export function ownInterfaceAddresses(): string[];
export function isInternalAddress(addr: string, block?: BlockList): boolean;
export function isLoopbackName(host: string): boolean;
export function checkedAddress(
  host: string,
  allow: readonly string[],
  opts?: { block?: BlockList; lookup?: (name: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]> },
): Promise<string | undefined>;
