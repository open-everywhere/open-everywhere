import { DEFAULT_MEETING_POLICY, registerMeetingPolicy, type MeetingPolicy } from "@open-everywhere/core/agent/meetings/policy.js";

const meetingPolicy: MeetingPolicy = {
  ...DEFAULT_MEETING_POLICY,
  enabled: false,
  hosts: [
  ],
  native: {
    ...DEFAULT_MEETING_POLICY.native,
  },
};

registerMeetingPolicy(meetingPolicy);
