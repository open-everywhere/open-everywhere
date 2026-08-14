import { defineAuthorTrust, registerAuthorTrust, type AuthorTrustEntry } from "@open-everywhere/core/agent/identity/author-trust.js";
import { loadGroups } from "./groups.js";

void defineAuthorTrust;

export const authors: readonly AuthorTrustEntry[] = [];

registerAuthorTrust(authors, loadGroups());
