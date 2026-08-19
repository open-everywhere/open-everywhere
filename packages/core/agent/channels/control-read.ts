import { defineChannel, GET } from "eve/channels";
import {
  CONTROL_READ_AUDIT_PATH,
  CONTROL_READ_USAGE_PATH,
  CONTROL_READ_UNIFIED_AUDIT_PATH,
  CONTROL_READ_TRANSCRIPT_PATH,
  CONTROL_READ_RUNTIME_SIGNAL_PATH,
  CONTROL_READ_MODEL_CALLS_PATH,
  handleAuditWindowRead,
  handleUsageWindowRead,
  handleUnifiedAuditRead,
  handleSessionTranscriptRead,
  handleRuntimeSignalRead,
  handleSessionModelCallsRead,
} from "../control/read-route.js";

export default defineChannel({
  routes: [
    GET(CONTROL_READ_USAGE_PATH, async (req) => handleUsageWindowRead(req)),
    GET(CONTROL_READ_AUDIT_PATH, async (req) => handleAuditWindowRead(req)),
    GET(CONTROL_READ_UNIFIED_AUDIT_PATH, async (req) => handleUnifiedAuditRead(req)),
    GET(CONTROL_READ_TRANSCRIPT_PATH, async (req, { attachSession, params }) => handleSessionTranscriptRead(req, attachSession, params)),
    GET(CONTROL_READ_RUNTIME_SIGNAL_PATH, async (req) => handleRuntimeSignalRead(req)),
    GET(CONTROL_READ_MODEL_CALLS_PATH, async (req, { params }) => handleSessionModelCallsRead(req, params)),
  ],
});
