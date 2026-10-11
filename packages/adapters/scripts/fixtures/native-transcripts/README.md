# Native-transcript fixtures (OPE-2471)

The response bodies `native-transcripts-test.ts` serves to the Teams, Meet and Zoom readers. Each file
follows the response shape in the platform's own reference documentation (Microsoft Graph `onlineMeeting`
and `callTranscript`; Google Meet REST v2 `conferenceRecords`, `transcripts`, `transcriptEntries` and
`participants`; Zoom `GET /meetings/{meetingId}/recordings`). The ids, names and times are made up.

**These are not captures from a live tenant.** No org credential was available when they were written. A
maintainer with the credentials replaces a file with a real, scrubbed response, and the test must stay green.
