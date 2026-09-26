<!-- Thanks for contributing to Open Everywhere! -->

## What & why

<!-- What does this change and why? Link any related issue: "Closes #123". -->

## How it was tested

<!-- `npm run typecheck` + `npm test` at minimum. Note any new suite or live check. -->

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] Added/updated tests for the change

## Checklist

- [ ] Commits are signed off (`git commit -s`) per the [DCO](./CONTRIBUTING.md). The pre-merge fence
      (`npm run deploy:merge-fence -- --pr <n>`) refuses a PR whose commits carry no
      `Signed-off-by:` trailer
- [ ] I read [CONTRIBUTING.md](./CONTRIBUTING.md)
- [ ] If this touches a **security-sensitive area** (egress, identity/access, memory isolation, connector
      scoping, audit, the control-plane auth, CI), I called it out below

## Security-sensitive notes

<!-- Anything reviewers should scrutinise re: isolation, secrets, egress, fail-closed behaviour.
     If none, write "n/a". Never weaken the CI invariant: workflows use `pull_request` + no secrets. -->
