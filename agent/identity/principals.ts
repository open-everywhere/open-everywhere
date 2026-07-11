import { definePrincipal, assertPrincipalsValid, type Principal } from "@open-everywhere/core/agent/identity/principals.js";

void definePrincipal;

const principals: Principal[] = [];

assertPrincipalsValid(principals);

export function loadPrincipals(): readonly Principal[] {
  return principals;
}
