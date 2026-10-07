Desktop reuses an existing local Paseo daemon: QA evidence

Upstream baseline: 8ddeb79c8dbb8934244b35ba18472fb9074d8209
Proposed tree: c2abf7b5ab93142a04a921b9980f57c35df75788
Both report 0.11.0-beta.5. Captured 2026-10-07 on macOS 27.0 (26A428), arm64.

before-error.png and before-actions.png are actual screenshots from the baseline
Electron renderer, with only machine names/private path prefixes replaced in live
text nodes immediately before capture. Application state, controls and assertions
were not changed. daemon-startup.log is the complete failing worker startup log,
redacted by the same substitutions. visible-error.txt is the full error page text.
No pairing tokens, user projects or agent content are included.

The unmodified upstream Desktop main and renderer used the rebuilt 0.11.0-beta.5
server/CLI dependency stack; this PR changes no server, CLI or wire code.
A fresh profile used a different daemon home at the independent daemon's actual
loopback port. The baseline shows EADDRINUSE while that daemon remains healthy.
before-result.json records the real port, same external PID before/after quit and
HTTP 200 health result. The test then cleans up only its own fixture daemon.

The regression unit test was copied onto the baseline without the implementation.
latest-regression-before.log records the intended failure: bundled start called.
The same test passes among the 101 app tests on the fixed tree.

The after images use empty profiles, connected automatically to real fixture
daemons. after-auto-connected.png is the source run; after-packaged-auto-connected.png
is the locally built macOS app. The full lifecycle and packaged runs also cover
protected-daemon password entry and saved-password reconnect, no-listener default
startup, owned shutdown on quit, external-daemon preservation, explicit disabled
startup, unrelated HTTP listeners, recovery and a real settings-write failure.

Commands and raw outputs
npm run build:server
npm run build:main --workspace=@getpaseo/desktop
npm run test --workspace=@getpaseo/app -- --project unit src/runtime/daemon-start-service.test.ts src/navigation/host-runtime-bootstrap.test.ts src/i18n/resources.test.ts src/desktop/daemon/daemon-management-toggle.test.ts
npm run test --workspace=@getpaseo/desktop -- src/settings/desktop-settings.test.ts src/daemon/local-daemon-candidates.test.ts src/daemon/daemon-manager.test.ts src/daemon/quit-lifecycle.test.ts
npm run test:e2e:lifecycle --workspace=@getpaseo/desktop
npm run typecheck
npm run lint
npm run format

These commands' focused test/check outputs are the adjacent latest-*.log files.
verify-latest-reuse.mjs is the extra baseline evidence capture script. It was run
from a directory containing source/ (the fixed checkout with installed dependencies)
and upstream-baseline-8ddeb79c8/ (baseline checkout):
node verify-latest-reuse.mjs upstream-baseline-8ddeb79c8 baseline
The script uses isolated homes and an OS-assigned loopback port, and cleans up its
own daemon. It does not start/stop the user's existing daemon.

Packaged app.asar SHA256:
1fc50f644283caeaced2303d536b6d74922e558b2dbfc91a44abe0ffacd66d01
The macOS bundle passed codesign --verify --deep --strict.
Windows/Linux and mobile/browser runtimes were not tested locally. The new startup
and discovery paths are Electron-gated. See the PR's platform matrix.

This evidence is on a separate branch so screenshots and local QA artifacts are
not part of the production-code pull request.
