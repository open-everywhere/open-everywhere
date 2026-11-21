# Open Everywhere QA browser container

The image the QA kit's browser runs in on the docker route (OPE-2671). The operator guide is
[`docs/capabilities/browser-qa.md`](../../docs/capabilities/browser-qa.md#on-docker-a-container-per-session).
This page is the image's own contract.

## Build the image

```bash
docker build -t oe-browser-qa:1 deploy/browser-qa
```

Build it on the daemon the app reaches through its socket. Then set `browser.boxImage` to the tag in
`agent/settings/settings.ts`.

## What the image holds

- The Playwright base image (`mcr.microsoft.com/playwright:v1.56.1-noble`): Node, and Chromium's system libraries.
- `agent-browser@0.32.4` and the browser build that `agent-browser install` fetches. Keep the pin equal to
  the vendor default in `@agent-browser/sandbox` (`DEFAULT_AGENT_BROWSER_INSTALL_SPEC`).
- `certutil` (`libnss3-tools`), so OE can make Chromium trust the egress proxy's CA under Tier B.
- The non-root user `pwuser`, which every browser call runs as.

The image size is not measured yet: no docker daemon ran in the build of OPE-2671.

## How OE runs it

OE starts one container per session with `docker run` (`packages/adapters/agent/sandbox/long-lived-box.ts`):

- `--network <sandbox.boxDockerNetwork>`: an internal network with no WAN route. OE refuses a network that
  is not internal.
- `--cap-drop ALL`, `--security-opt no-new-privileges`, a pid limit, `--user pwuser`, `--rm`.
- `--entrypoint timeout` with the command `sleep infinity`: the one-hour cap.
- The env NAMES `HTTP_PROXY`, `HTTPS_PROXY`, `OE_BOX_EGRESS_PROXY` (the proxy's origin) and, under Tier B,
  `OE_BOX_EGRESS_CA` (the proxy's CA, a public certificate). The values travel in the docker CLI's
  environment, never on the argv. No credential is passed.

Then OE pushes `"deny-all"` for the container's IP, binds the IP to the session (the proxy now holds it to the
session's own policy), and imports the CA into `$HOME/.pki/nssdb`. Each browser call is
`docker exec -i <container> sh -c "agent-browser … --proxy <proxy>"`. The container stops after ten minutes
with no call, at its cap, or when its open fails, and its stop drops its IP's policy at the proxy.
