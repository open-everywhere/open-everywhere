import { defineChannel, GET } from "eve/channels";
import {
  CONTROL_READ_AUDIT_PATH,
  CONTROL_READ_USAGE_PATH,
  CONTROL_READ_UNIFIED_AUDIT_PATH,
  handleAuditWindowRead,
  handleUsageWindowRead,
  handleUnifiedAuditRead,
} from "../control/read-route.js";

export default defineChannel({
  routes: [
    GET(CONTROL_READ_USAGE_PATH, async (req) => handleUsageWindowRead(req)),
    GET(CONTROL_READ_AUDIT_PATH, async (req) => handleAuditWindowRead(req)),
    GET(CONTROL_READ_UNIFIED_AUDIT_PATH, async (req) => handleUnifiedAuditRead(req)),
  ],
});
