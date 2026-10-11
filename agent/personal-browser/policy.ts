import { DEFAULT_PERSONAL_BROWSER_POLICY, registerPersonalBrowserPolicy, type PersonalBrowserPolicy } from "@open-everywhere/core/agent/personal-browser/policy.js";

const personalBrowserPolicy: PersonalBrowserPolicy = {
  ...DEFAULT_PERSONAL_BROWSER_POLICY,
  enabled: false,
};

registerPersonalBrowserPolicy(personalBrowserPolicy);
