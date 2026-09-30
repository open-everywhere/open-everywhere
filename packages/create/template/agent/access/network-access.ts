import { assertNetworkAccessValid, defineNetworkAccess, type NetworkAccessBinding } from "@open-everywhere/core/agent/access/network-access.js";

const networkAccess: NetworkAccessBinding[] = [
];

assertNetworkAccessValid(networkAccess);

export function loadNetworkAccess(): readonly NetworkAccessBinding[] {
  return networkAccess;
}
