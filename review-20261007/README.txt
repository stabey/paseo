Review fixes for getpaseo/paseo#6314
Candidate: 071fb321d97d55a6cfcfd2c4ea1678be2b968e68
Previous head: c2abf7b5ab93142a04a921b9980f57c35df75788
Platform: macOS 27.0 arm64. No Windows/Linux native runtime run.

Finding 4207705524: Move the pending local password form into the app-wide shell. The real Electron regression failed on the previous code with an existing offline host: the password form never appeared. The fixed source and packaged app pass; the package also checks a saved online host, cancellation, and saved-password reconnect without another prompt.
Finding 4207705538: Automatically registering a daemon matches serverId only, leaving a different saved host on the same endpoint untouched. The baseline unit regression lost srv_old_home. The fixed unit and real packaged checks preserve the old profile (including relay/password/appearance) and keep the new profile separate.
Finding 4207705555: An aggregate error retains both startup and rollback failures, and explains automatic startup remains enabled. The baseline unit exposed only the settings failure; the fixed regression preserves both errors.

Validation commands:
cd packages/app
npx vitest run src/runtime/host-runtime.test.ts src/runtime/daemon-start-service.test.ts src/types/host-connection.test.ts src/desktop/daemon/daemon-management-toggle.test.ts --bail=1
=> 150 tests passed. After naming the aggregate error class, the 11 toggle tests were rerun and passed.

At repo root: npm run typecheck; npm run lint; npm run format
All passed, and commit hooks repeated all three successfully.
PASEO_DESKTOP_LIFECYCLE_ARTIFACT_DIR=<output> npm run test:e2e:lifecycle --workspace=@getpaseo/desktop
=> Passed real source Electron lifecycle, password-with-saved-offline-host, reuse, recovery, ownership and slow startup cases.

PASEO_WEB_PLATFORM=electron EXPO_NO_DOTENV=1 npx expo export --platform web
npx electron-builder --config <local-review-builder> --mac --arm64 --dir --publish never
codesign --verify --deep --strict '<local app>'
node verify-review-packaged.mjs
=> Passed the expanded startup/recovery harness against the packaged app, including separate identities on a reused port, online/offline saved hosts, cancellation and password restoration.

The packaged observer uses raw app launch + CDP and calls the checked-in verifyStartupFailureRecovery harness. All lifecycle actions target isolated fixture homes and ephemeral ports. The user's production daemon was not stopped/restarted. Probe-only default-port discovery may see that daemon but tests never select or manage it.
Public logs redact only private path prefixes and machine names. Additional screenshots remain local because the discovery list includes the private machine name.
Packaged app-dist fingerprint (sorted relative path + NUL + SHA256(file bytes), then SHA256 of concatenation): 10fc0f6edf68548fc3793143c2b6dfe5e43a9df1900a606d6054db3c3975934e
