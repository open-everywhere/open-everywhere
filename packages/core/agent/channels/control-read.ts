import { defineChannel, GET } from "eve/channels";
import {
  CONTROL_READ_AUDIT_PATH,
  CONTROL_READ_USAGE_PATH,
  CONTROL_READ_UNIFIED_AUDIT_PATH,
  CONTROL_READ_TRANSCRIPT_PATH,
  CONTROL_READ_CONNECT_PROBE_PATH,
  handleAuditWindowRead,
  handleUsageWindowRead,
  handleUnifiedAuditRead,
  handleSessionTranscriptRead,
  handleConnectProbeRead,
} from "../control/read-route.js";

export default defineChannel({
  routes: [
    GET(CONTROL_READ_USAGE_PATH, async (req) => handleUsageWindowRead(req)),
    GET(CONTROL_READ_AUDIT_PATH, async (req) => handleAuditWindowRead(req)),
    GET(CONTROL_READ_UNIFIED_AUDIT_PATH, async (req) => handleUnifiedAuditRead(req)),
    GET(CONTROL_READ_CONNECT_PROBE_PATH, async (req) => handleConnectProbeRead(req)),
    GET(CONTROL_READ_TRANSCRIPT_PATH, async (req, { getSession, params }) => handleSessionTranscriptRead(req, getSession, params)),
  ],
});
