import { defineChannel, GET } from "eve/channels";
import { PRIVACY_PAGE_PATH, TERMS_PAGE_PATH, policyPageResponse } from "../pages/policy-pages.js";

export default defineChannel({
  routes: [
    GET(PRIVACY_PAGE_PATH, async () => policyPageResponse("privacy")),
    GET(TERMS_PAGE_PATH, async () => policyPageResponse("terms")),
  ],
});
