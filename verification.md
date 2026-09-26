# Project directory discovery — review evidence

Code revision: `12a9b71` (includes `91c5dfb`, `d7cc9be`, and `4bb86ed`).
Environment: macOS arm64, Node 26.9.0, Paseo 0.9.2 source checkout.

## Animated walkthroughs

The GIFs are sequences of real browser screenshots with pauses and captions added below the UI. They are not continuous video or native-app recordings. Paths belong to a disposable demo directory on an external volume; the browser uses an isolated local daemon and a host label of **Demo Mac**. The demo removes `~` so only the fixture directory appears in public search results. Keeping `~` alongside another root is also supported and was checked locally.

- `project-search-desktop.gif`: desktop web at 1280 × 720, 22.6 seconds. Add a root, remove home, save, keyword search, Enter to browse, absolute-prefix search, Tab to complete, then activate **Add this directory** with Enter.
- `project-search-mobile.gif`: mobile web viewport at 390 × 844, 19.6 seconds. Settings entry, add/remove a root, save, keyword search, click a result to browse, then click the separate confirmation button.

## Real browser / daemon observations

- The initial settings value is `~`; Save is disabled until a valid change is made.
- Relative input `work` displays a validation error and cannot be saved.
- Add directory focuses the new input. Removing a row keeps the other path intact.
- Reset to home followed by Save persists an empty `projects` configuration, restoring the default.
- Saving a configured directory writes `projects.searchRoots`; subsequent searches use it without restarting the daemon.
- With `bridge` typed, Add this directory is disabled. Selecting a result fills its absolute path, lists children, and leaves the picker open.
- After browsing on mobile, the real daemon still reported `projects: 0, agents: 0`. After explicit confirmation it reported `projects: 1, agents: 0`.
- Desktop Enter and Tab both complete/browse. Enter on the focused confirmation button adds the project and opens the new-workspace screen.
- The completed bundle was installed on the local daemon. `server_info.features.projectSearchRoots` is true; existing configured roots are retained and an external `bridge` directory is found.

## Targeted test commands and recorded output

Paths below are relative to the checkout. Only targeted suites were run; no full test suite.

From `packages/app`:

```text
npx vitest run src/screens/settings/project-search-form-model.test.ts src/i18n/resources.test.ts --project unit --maxWorkers=1 --bail=1

 Test Files  2 passed (2)
      Tests  42 passed (42)
   Duration  1.12s
```

The form suite covers invalid paths, POSIX/tilde/Windows/UNC input, the 16-root limit, minimum one row, reset, stable row identity after removal, and preserving unsaved drafts across configuration updates. The other suite checks translation resource consistency.

From `packages/server` (earlier commits; unchanged by the settings UI):

```text
npx vitest run src/utils/directory-suggestions.test.ts --bail=1
 Test Files  1 passed (1)
      Tests  46 passed (46)

npm run test:unit -- src/server/persisted-config.test.ts src/server/config.test.ts --bail=1
 Test Files  2 passed (2)
      Tests  64 passed (64)

npm run test:unit -- src/server/daemon-config-store.test.ts --bail=1
 Test Files  1 passed (1)
      Tests  35 passed (35)
```

The real daemon/client test was rerun after adding the capability flag:

```text
npx vitest run src/server/daemon-client.e2e.test.ts -t 'applies configured project search roots' --maxWorkers=1 --bail=1
 Test Files  1 passed (1)
      Tests  1 passed | 38 skipped (39)
   Duration  7.31s
```

This uses real filesystem directories and WebSocket RPCs. It verifies capability advertisement, patching roots in an existing session, keyword discovery, explicit paths outside the configured roots, and unchanged workspace scope.

From the checkout root:

```text
npm run build:server
# exit 0

npm run build:daemon-web-ui
Daemon web UI bundle:
  raw:    20.77 MiB
  gzip:   4.60 MiB
  brotli: 3.39 MiB
# exit 0

npm run typecheck
# all workspaces with typecheck scripts completed; exit 0

npm run lint
Found 0 warnings and 0 errors.
Finished in 932ms on 4326 files with 177 rules using 10 threads.

npm run format:files -- <changed files>
# exit 0

git diff --check
# exit 0
```

## Platform and compatibility limits

| Surface | Evidence |
| --- | --- |
| Desktop web on macOS | Real browser, live daemon; keyboard and pointer interactions |
| Mobile web layout | 390 × 844 viewport in the same desktop browser; pointer clicks, no software keyboard |
| Native iOS / Android | Not run |
| Packaged Electron on macOS / Windows / Linux | Not run |
| Windows / Linux daemon | Not run; path syntax is validated in unit tests, which is not filesystem integration coverage |

The optional config fields and feature flag preserve wire parsing. The settings editor checks `server_info.features.projectSearchRoots` at its entry point and displays an update-host message when unavailable. Older clients can ignore the new fields and continue using existing RPCs. The old-client/new-daemon and new-client/old-daemon binary combinations were not run end-to-end; compatibility was reviewed at the schema and feature boundary.
