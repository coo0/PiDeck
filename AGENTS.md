# Repository Guidelines

Single source of repository rules for AI assistants and contributors. Historical architecture notes elsewhere in `docs/` are research/plan artifacts — where they disagree with this file or with code, **this file and the code win**.

## Project Overview

**PiDeck** (`package.json` name `pi-desktop`) is an Electron desktop workbench for running and managing multiple AI coding-agent sessions across local project folders. It ships a multi-project workspace, session timeline + history restore, file drawer, Git panel, built-in terminal/browser/editor, model config, tool-call rendering, prompt/skill/extension stores, and packaging/release pipelines.

**Core boundary — never cross it:**

- **pi / DSH own agent behavior**: tools, session read/write, model calls, context management. Do not reimplement them.
- **PiDeck owns the shell**: window management, process lifecycle, session browsing/import, Git panel, terminal, settings, packaging. Do not push UI concerns into pi.
- The two talk over **stdio JSON-RPC only**. Introducing a second channel (e.g. HTTP into pi internals) is forbidden.

Backends: `AgentBackend = "pi" | "dsh" | "imagegen"` (`src/shared/types/agent.ts`). `imagegen` runs no agent at all — it is a local image-generation session store.

## Architecture & Data Flow

Three-process Electron layout with a shared contract layer, plus a `utilityProcess` DSH host and child pi/DSH processes.

```
renderer (React 19 + Jotai)
  └─ src/renderer/src/desktopApi.ts  → window.piDesktop (contextBridge)
       └─ src/preload/index.ts       → ipcRenderer.invoke / on
            └─ src/main/ipc/*Ipc.ts  → ipcMain.handle (validate → adapt)
                 └─ src/main/<domain>/*.ts   (business logic)
                      └─ child procs: pi (stdio JSON-RPC) | DSH host (utilityProcess)
```

**Request path:** renderer calls `desktopApi.<ns>.<fn>()` → preload forwards to a channel constant → `src/main/ipc/*Ipc.ts` handler validates input and adapts → domain service in `src/main/<domain>/` does the work → structured result back over IPC.

**Event path:** main → `webContents.send(channel, payload)` → preload `subscribe()` returns an **unsubscribe** function → renderer hook cleans up on unmount.

**Runtime identity (hard invariant).** `SessionRecord.id` is the stable cross-restart session identity; `agentId` only identifies the *current* pi child process. Every runtime command and event carries `sessionId + agentId + runtimeGeneration`. `src/main/sessions/SessionRuntimeCoordinator.ts` mints generations on bind/rebind and **must reject late results from a stale generation**. New runtime paths must follow this triple — never key runtime state on `agentId` alone.

**Composition root.** `src/main/index.ts` (4359 lines) only wires dependencies: it constructs services, calls `registerIpc()` (line ~2316), registers cleanup, and manages the app lifecycle. New business logic goes into a new module under `src/main/<domain>/`, never into `index.ts`.

**IPC registration triple.** Every new channel needs exactly three synchronized edits, or it is a runtime `undefined`:

1. `src/shared/ipc.ts` — add the constant (`ipcChannels.<name> = "domain:action"`). ~500 constants live here; no string literals anywhere else.
2. `src/main/ipc/<domain>Ipc.ts` — `ipcMain.handle(ipcChannels.<name>, ...)`, first line validates input.
3. `src/preload/index.ts` — expose under the matching namespace object (`api.<ns>.<fn>`) with an explicit return type. Subscription APIs must return `() => ipcRenderer.removeListener(...)` (the shared `subscribe<T>()` helper at the bottom of the file does this).

Example (real, working): `gitRefsChanged: "git:refs-changed"` in `src/shared/ipc.ts:423` → sent from `src/main/ipc/gitIpc.ts:597` → subscribed in `src/preload/index.ts:735-737`.

**Data flow for the DSH backend:** `src/main/dsh/` spawns a `utilityProcess` entry (`out/main/hostEntry.js`) which boots the DSH runtime; `DshAgentManager` + `dshEventProjector.ts` project DSH events into PiDeck's message model. DSH runtime binaries come from `dist-runtime/dsh-runtime` (gitignored, packed by `scripts/pack-dsh-runtime.mjs`).

## Key Directories

| Path | Purpose |
|---|---|
| `src/shared/` | Cross-process **contract only**. `shared/types/*.ts` split by domain; `shared/types.ts` is a backward-compat barrel; `shared/ipc.ts` is the only place channel names exist. Must not import any runtime layer. |
| `src/main/` | Only layer allowed to touch Node/Electron. ~40 domains: `pi/` (agent process, RPC, projections), `dsh/`, `sessions/` (scan, import, catalog, `SessionRuntimeCoordinator`), `ipc/`, `git/`, `projects/`, `settings/`, `config/`, `extensions/`, `skills/`, `prompts/`, `imagegen/`, `terminal/`, `feishu/`, `automation/`, `pet/`, `web/`, `update/`, `health/`, `security/`, `logging/`, `lifecycle/`, `wsl/`, `window/`, `memory/`, `usageStats/`, `voice/`, `sounds/`, `rewind/`, `resourceImport/`, `browser/`, `clipboard/`, `editors/`, `diagnostics/`, `announcements/`, `agents/`, `fs/`, `process/`, `utils/`. |
| `src/main/ipc/` | 27 files, ~410 `ipcMain.handle` registrations. Handlers are thin: validate → adapt → delegate. |
| `src/preload/index.ts` | 1334 lines, 48 API namespaces. `contextBridge.exposeInMainWorld("piDesktop", api)`. No business logic, no state. |
| `src/renderer/src/` | 632 `.ts/.tsx` files. `atoms/` (Jotai, session-first), `components/{session,sidebar,workspace,app,ui-shadcn,motion,agents,overlays,terminal,automation,config,feishu,scratchPad}/`, `hooks/`, `i18n/`, `lib/`, `styles/`, `utils/`, `web/`, `pet/`. |
| `src/types/` | Ambient `.d.ts` only (`sql.js.d.ts`). |
| `tests/` | 751 `*.test.mjs` files + `helpers/` + `fixtures/`. |
| `e2e/` | 45 Playwright specs driving the built app. |
| `scripts/` | 64 build/generate/check/pack/release scripts. |
| `resources/` | Shipped content: `extensions/`, `skills/`, `prompts/`, `xueprompts.db`, `pi-ai-catalog.json`, `dsh-runner-node/`. |
| `packages/` | Local `file:` workspace packages (e.g. `dsh-tool-pwsh-persistent`); `lib/` is generated and gitignored. |
| `docs-site/` | VitePress site (included in `npm run typecheck`). |
| `announcements-md/` | Sole edit entry for announcements → generated `announcements.json`. |

## Development Commands

| Scenario | Command |
|---|---|
| Dev app (electron-vite dev server) | `npm run dev` |
| Type check (after every change) | `npm run typecheck` |
| Targeted unit tests (daily gate) | `node --test tests/<related>.test.mjs` |
| Full unit suite (~40s+, only for cross-domain changes / pre-merge) | `npm test` |
| Serial unit suite (debugging concurrency flakiness) | `npm run test:serial` |
| Format / verify format | `npm run format` / `npm run check:format` |
| Full build (generators + runtime pack + typecheck + electron-vite) | `npm run build` |
| Fast build (skips runtime pack / xueprompts check) | `npm run build:fast` |
| Main+preload only (~4s, when the dev watcher stalls) | `npm run build:main` |
| Quick package validation (`--dir`) | `npm run pack` |
| Platform installers | `npm run dist:mac` / `dist:win` / `dist:linux` |
| E2E (builds first) | `npm run test:e2e` |
| Docs site | `npm run docs:dev` / `docs:build` |

**`npm run build` chain (order matters):** `sync:dsh-version` → `build:packages` → `generate:pi-ai-catalog` → `generate:extensions-manifest` → `generate:prompts-manifest` → `generate:skills-manifest` → `runtime:pack` → `runtime:check` → `check:xueprompts` → `tsc --noEmit` → `electron-vite build`.

**Generator → artifact → guard:**

| Generator | Artifact | `--check` command |
|---|---|---|
| `generate-extensions-manifest.mjs` | `resources/extensions/extensions-manifest.json` | `npm run check:extensions-manifest` |
| `generate-content-manifests.mjs --domain prompts` | `resources/prompts/*.md` + `prompts-manifest.json` | `npm run check:prompts-manifest` |
| `generate-content-manifests.mjs --domain skills` | `resources/skills/skills-manifest.json` | `npm run check:skills-manifest` |
| `generate-pi-ai-catalog.mjs` | `resources/pi-ai-catalog.json` + `.manifest.json` | `npm run check:pi-ai-catalog` |
| `build-announcements.js` | `announcements.json` (repo root) | `npm run check:announcements` |
| `sync-dsh-declared-version.mjs` | `package.json` `dshRuntimeVersion` | `--check` flag |

**Commit rules.** Do **not** run `git add` / `git commit` / `git push` unless the user explicitly asks. One feature/fix = one commit, no self-initiated splitting. Fixes go directly on the current dev branch — do not open `fix/issue-*` branches (parallel agents collide in the worktree). `fix:` / `feat:` / `chore:` prefixes.

**Release.** Update `CHANGELOG.md` + `CHANGELOG.zh-CN.md` (kept in sync), then `node scripts/sync-release-notes.js` (preview) → `--apply`, which rewrites `README.md`, `README.en.md`, `docs-site/changelog.md`. The script does not touch the README version badge — update it by hand. Run `node scripts/sync-workflow-choices.js --check` before release so the `release.yml` tag dropdown matches the CHANGELOG. Version bump commit: `chore: release vX.Y.Z`.

## Code Conventions & Common Patterns

### Formatting (biome — hard gate)

Config `biome.jsonc`: tab indent, double quotes, semicolons, trailing commas, LF, **`lineWidth: 320`** (biome's max). The wide line width is deliberate — the repo has 54% of lines over 80 chars and aggressive reflow breaks the many source-regex contract tests. Scope is `src/`, `tests/`, `scripts/`, `e2e/`; **CSS, `docs-site/`, `resources/extensions/` are excluded**; the JSON formatter is disabled so generated manifests don't drift. The linter is `enabled: false` — enable rules incrementally per touched area, never in bulk. `eslint` appears in devDependencies but has no config and is not wired into any script.

### Language and typing

- TypeScript strict; `noImplicitOverride: true`; `allowImportingTsExtensions: true`; `noEmit`.
- Path aliases: `@/*` and `@renderer/*` → `src/renderer/src/*`; `@shared/*` → `src/shared/*`.
- **Never add `any`.** Interfacing with third-party code: use `unknown` + narrowing, with a comment explaining why.
- **Never use `as` to silence a type error.** Test data needing partial fields uses a factory that builds a complete object.
- Naming: types/classes PascalCase, functions/variables camelCase, constants UPPER_SNAKE, IPC channels `domain:action`.
- React: function components + hooks; every effect has a cleanup; derived state via `useMemo` — never store a computable value in state.

### Module cohesion (hard rules)

1. **One module, one job.** State machines / policy / geometry / parsing go in pure functions (`utils/` or a domain helper); UI only renders and forwards events; a hook owns that domain's state and commands.
2. **Assembly layers only assemble.** `App.tsx` (4195 lines) and `main/index.ts` (4359 lines) must not grow new business branches. Extract `hooks/useXxx`, a host component, or atoms instead. Known size debt: `src/main/pi/AgentManager.ts` (6399), `App.tsx` (4195), `ConfigModal.tsx` (2982), `DshAgentManager.ts` (2292), `SessionScanner.ts` (2216). Target ≤400 lines/file; >600 requires a split assessment.
3. **Extract hooks by domain, not per screen.** Cross-subtree domains (session workspace chrome, composer, timeline) get one owner. A 30+ field "shared props bag" threaded App → Pane → Injector → View is prohibited; use narrow interfaces, context, or factories. View props keep only identity and chrome switches.
4. **Selection ≠ presentation.** `selectSession` only decides *which session is current*. Tab preview/permanent, split layout, and drag MIME belong to the chrome domain — do not leak `preview | permanent | keep` modes into generic selection APIs.
5. **Multi-instance subscribes per session.** In split/multi-pane mounts, runtime/messages/sendState subscribe only to their own `sessionId` atom family. A non-focused pane must never subscribe to `currentSession*` globals.
6. **Pure policy is unit-testable.** Drop edges, preview replacement, split-close promotion become pure functions with `tests/*.test.mjs`. Product policy hidden in a JSX lambda ("third tab replaces focused pane") must live in the same chrome/reducer.
7. **Async and drag-drop use snapshots.** `drop` / `close` / timers must not close over stale `tabs`/`previewId`; use ref snapshots, `useCallback`-stable commands, or a single `dispatch`. Dependency arrays never contain the whole `props` object.
8. **One mount point per UI capability.** Session tab bar and right-drawer toggles mount once in the outer shell, not separately per solo/split parent.
9. **Pre-merge self-check:** does this make `App.tsx` know more business detail (extract first)? Does new state have a single owner? Are subscriptions isolated by `sessionId`? Can the core rule be tested without React?

### State management (Jotai, session-first)

Cross-component state lives in `src/renderer/src/atoms/`, split by domain and re-exported from `atoms/index.ts`. A second global state solution is forbidden. Per-session values use `atomFamily(sessionId => selectAtom(mapAtom, m => m[sessionId], Object.is))` — see `session-atoms.ts`, `composer-atoms.ts`, `runtime-atoms.ts`, `pi-thinking-atoms.ts`, `provider-usage-atoms.ts`, `project-atoms.ts`.

**Leak rule:** Jotai `atomFamily` has no automatic GC. Whenever a data entry is released, call `.remove(id)` on the family in the same path (see the comments on `streamingThinkingEntryByIdAtomFamily` and `runtimeCapabilityByAgentIdAtomFamily`), or long sessions leak.

### Renderer ↔ main access

Renderer reaches the main process only through `desktopApi` (`src/renderer/src/desktopApi.ts`), which resolves `window.piDesktop` (Electron), a browser API (LAN web), or a preview stub. Never import Node/Electron in renderer. Global `Window.piDesktop` typing lives in `src/renderer/src/types.d.ts`.

### i18n

All user-visible text goes through i18n: renderer keys in `src/renderer/src/i18n/rendererCopy.zh-CN.ts` + `rendererCopy.en-US.ts` (kept in parity, both ~4300 lines), main-process copy in `src/shared/i18n/mainProcessCopy.ts`. Hardcoded Chinese/English in JSX is prohibited. A `pseudo` locale exists for expansion testing. Logs, debug output, and internal identifiers may be hardcoded — but logs go through the main-process logging module (`appLogger`), not scattered `console.log` (delete debug leftovers).

### Error handling and lifecycle

- Main: catch, log via `appLogger`, return a **structured error** across IPC — never throw a bare exception over the boundary.
- Renderer: user-visible failures go to a toast via `showNotice(...)` (`src/renderer/src/utils/notice.ts`, sonner-backed, falls back to DOM toast before `Toaster` mounts) or inline friendly copy. Not console-only. 84 files use it.
- No bare promises without `catch`.
- **Lifecycle pairing is mandatory:** every `listener` / `timer` / child process / `watcher` / terminal registered somewhere must have a matching cleanup in the same module (unmount, quit, session close). Long-lived resources register with `src/main/lifecycle/QuitCleanupRegistry.ts` instead of editing `before-quit` in `index.ts`.
- **Resource bounds:** large file reads, session scans, and diff computation need size limits or streaming; the renderer must never hold full logs/history in main memory.

### Security (hard rules)

1. **Least-privilege IPC:** preload exposes only what the current page needs; no `ipcRenderer` passthrough. New channels must be added to the type definitions.
2. **Validate at the boundary:** the first responsibility of every IPC handler is validating input (type, path legality, enum range). Renderer data is untrusted.
3. **Path safety:** file I/O stays inside project directories or the app data directory; normalize and check for escape before joining — never concatenate user input directly.
4. **Process calls:** `spawn`/`exec` take argument **arrays**, never interpolated shell strings. Child env is cleaned by `PiLocator.sanitizePiChildEnv`.
5. **Webview/browser panel:** never load arbitrary local content besides `file://`; keep `allowpopups` and node integration minimal — new webview attributes require review.
6. **Secrets:** auth config is read/written only through `src/main/config/`. Tokens/keys must never appear in logs, error reports, or telemetry.
7. **Dependencies:** justify every new dependency; prefer existing capabilities; no heavy libraries for small features.

### CSS dual-track (hard rules)

Two styling systems coexist. **No big-bang rewrite, and no second visual language.**

| Track | What | Where |
|---|---|---|
| Legacy | hand-written semantic classes | `styles/{foundation,timeline,surfaces,integrations,workspace,usageStats}.css` |
| UI 2.0 | Tailwind v4 + shadcn | `styles/tailwind.css`, `components/ui-shadcn/` |

Motto: **visually "new learns from old"; in code "migrate legacy → new as you touch it."**

1. **Tokens/appearance follow legacy.** Colors, radii, font sizes, spacing keep using `foundation` semantic variables; the new stack bridges the same tokens via `@theme` — do not create a parallel zinc/indigo palette.
2. **New changes write only Tailwind + shadcn.** New hand-written CSS classes are forbidden (except tokens, keyframes, and existing `tone-*`/`status-*` anchors).
3. **Converge incrementally by touch.** When changing a UI block, delete or narrow the legacy rules competing for the same properties, then rely on utilities.
4. **Cascade layer order is load-bearing** (entry `src/renderer/src/styles.css`, contract test `tests/cssCascadeLayers.test.mjs`):

   `theme < base(preflight) < components < vendor < legacy < utilities`

   - `legacy` **must be above** `base`: otherwise preflight wipes the app's hand-written appearance ("all CSS is gone").
   - `legacy` **must be below** `utilities`: otherwise Tailwind edits on components don't apply.
   - `vendor` (streamdown / file-icons) sits **below** `legacy` so in-app overrides beat third-party defaults.
   - The five legacy domain files are imported only in the entry with `layer(legacy)`; vendor only with `layer(vendor)`; **never nest `@layer` inside those files**.
5. **`!important` inverts layer priority.** Legacy `!important` can still beat utilities — remove the `!important` or narrow the rule; never pile `!` onto utilities.
6. **Half-migrated utilities are worse than none.** A stray `min-h-11`/`rounded-xl` will now really apply and override legacy appearance. Align the utility to the original visual, then delete the redundant legacy declaration.
7. **Debugging:** when a utility "doesn't show", check DevTools for the winning rule's layer — unlayered / `!important` / a same-property legacy selector — and fix the conflict source first.
8. **`accent` is a surface, not text.** `--color-accent` = `--color-bg-active` (hover surface, matching shadcn's accent semantics), so `text-accent` and `hover:bg-accent` resolve to the same value → invisible text. Body text on a surface uses `text-accent-foreground`; theme emphasis text uses `text-primary`. Guard: `tests/storeSuggestionChipContrast.test.mjs`.

### beUI component migration

Motion/agent components are migrated from beui.dev.

1. Install via CLI, never by hand-copying source: `npx shadcn add @beui/<name>` (`components.json` already registers `@beui` → `https://beui.dev/r/{name}.json`); add `--overwrite` when the file exists.
2. Shared files (`lib/ease.ts`, `lib/utils.ts`, `agents/agent-disclosure.tsx`) stay byte-identical to the official registry. **Never store project-private curve values in them** — historically `EASE_OUT`/`SPRING_LAYOUT` were forked and every CLI install clobbered them.
3. Shared motion constants come from `@/lib/ease`; missing constants are added at official values, existing exports never change.
4. Files go under `src/renderer/src/components/<domain>/` with the official `// beui.dev/components/<path>` header; user-visible copy goes through i18n.

### Source-text contract tests

Many tests scan production source with regexes. **New regex assertions must be whitespace-tolerant** (`\s*` instead of literal spaces, `[\s\S]{0,80}?` instead of literal `\n`) and anchor code blocks with `^[\t ]*` rather than `indexOf("  function …")` — otherwise one format run fails the whole group.

### Subsystem invariants

**Announcements (`announcements-md/` → `announcements.json`).** The markdown files are the sole edit entry; hand-editing the root JSON is forbidden and `--check` asserts byte-identity. Front matter requires `id` (stable, unique, no whitespace), `title`, `level` (`info|warn|critical`), `publishedAt`, `effectiveUntil` (ISO 8601); optional `minVersion`, `category` (`flash|notice|guide`, default `notice`). Ship by committing `.md` + `.json` together to `main`. Retire by deleting the `.md` or letting `effectiveUntil` expire. Rendering safety: list cards show only `announcementExcerpt()`-sanitized summaries — full markdown renders through `MarkdownStream` (light mode) in the detail dialog. Never render markdown in the card or add a second announcement render path.

**Built-in extensions hot update (`resources/extensions` + userData overlay).** Built-in `*.ts` extensions ship in the package and are injected into pi via `-e <abs path>`. Update flow: fetch remote manifest → write `<userData>/builtin-extensions/` overlay → path resolution prefers the overlay → restart the session. Manifest (`extensions-manifest.json`) holds `schemaVersion` / `version` / `bundleSha256` / `fileCount` / per-file `name+sha256+bytes`; `version` is the **package-level** version (`--set-version` bump), not PiDeck's app version. `package.json` `extraResources` for `resources/extensions` **must filter both `*.ts` and `extensions-manifest.json`**. Update detection is **per-file sha256, not the version number** — forgetting to bump the version must still be detected. Remote manifests listing unknown filenames are ignored: `BUILT_IN_EXTENSIONS` (`src/main/extensions/builtInExtensions.ts`, 12 entries) is compiled in. The overlay must be a **complete self-consistent snapshot** (extensions import each other, e.g. `pi-deck-todo.ts` → `./pi-deck-todo-state.ts`) and must **vendor its runtime deps** (`node_modules/undici`): the pi extension loader walks up from the extension's own directory, and the overlay has no `node_modules` above it — a missing dep is `MODULE_NOT_FOUND` → pi exits code=1 → PiDeck disables all extensions and restarts. `VENDOR_DEP_PACKAGE_NAMES` and the extensions' bare imports are cross-checked by `tests/extensionPackagingDeps.test.mjs`; new runtime deps must be added to both `extraResources` and that list. All three disk roots (ExtensionManager listing, updater writes, `-e` resolution) must share one source via `resolveBuiltInExtensionRoots()` in `src/main/index.ts`. Safety: download-verify-then-atomic-replace (tmp → `.bak` swap → rename, rollback on failure) and `invalidateBuiltInExtensionsOverlayCache()` after every write/restore.

**Image generation storage (`userData/imagegen`).** Sessions index at `<userData>/imagegen/sessions/<id>.jsonl` (`ImageSessionStore`); image bytes at `<userData>/imagegen/blobs/<sha256>.<ext>` (`ImageBlobStore`, content-addressed). Both roots resolve via `resolveImageGenStorageRoots()`. **Hard constraint: no base64 in JSONL** — messages store `{type:"image", ref, mimeType}`; `ImageContent.data` is a transient in-flight form. Background: the old design inlined base64 per image with `MAX_MESSAGES=2000` limiting lines but not bytes → 246 MB in 28 turns → renderer OOM → crash-reload loop → white screen. Three defenses must all hold: byte watermark, append-only writes, bounded tail reads. `readMessages()` reads only the trailing `MAX_READ_BYTES` window (dropping a partial first line) — never revert to reading the whole file. Legacy inline-base64 files self-heal on first read/write by streaming line-by-line migration. Renderer must never hand-write `data:${mimeType};base64,${data}` (history images have `data === undefined` → silently blank image): all `<img src>` goes through `imageContentSrc()` in `src/shared/imageContentSrc.ts` (inline → data URL; ref → `pideck-img://blob/<ref>`); copy/save/resend use `loadImageBase64()` / `hydrateImageContents()` via `imagegen:read-image-blob`. The `pideck-img://` protocol is declared in `registerSchemesAsPrivileged` before ready and handled after ready; `img-src` is already allowed in `src/renderer/index.html`'s CSP. Orphan blob pruning has a 1-hour grace period and **fails closed** (scan failure aborts the prune).

**Prompt store DB (`resources/xueprompts.db`).** Shipped via `extraResources`; **changing the DB requires repackaging**. Tables: `xueprompt_categories(slug PK, name, count)`, `xueprompts(id PK, slug UNIQUE, url, title, category, content BLOB, description BLOB)` — 4012 prompts / 16 categories. Built-in templates are written by `scripts/add-builtin-prompts.mjs` from `docs/pi-prompt-templates/*.md` (README skipped) into category `编程提示词`, idempotent via `INSERT OR REPLACE` + full count recompute. `npm run check:xueprompts` asserts category counts match, all built-in templates are present, and bodies decompress; it is wired into `npm run build`. **Query boundary:** `content`/`description` are gzip BLOBs — SQL `LIKE` compares bytes and never matches Chinese keywords. Any text search over these fields must `gunzipSync` in application code (see `XuePromptManager.list`); `title` is plain TEXT and may use SQL.

**README / docs-site shared images.** Cyclic images used by both README and the site live **only** in `docs/images/<name>`; never keep a second copy in `docs-site/public/images/`. `docs-site/.vitepress/sharedReadmeImages.ts` copies the whitelist during `configResolved` (must stay there — Vite snapshots `publicDir` when `createServer` starts). Generated copies are gitignored; a missing source throws rather than skipping. Adding one: update `SHARED_README_IMAGES`, `.gitignore`, and the four assertions in `tests/docsSharedImages.test.mjs`. README uses repo-relative `docs/images/<name>`; the site uses root-absolute `/images/<name>` — not interchangeable.

**Prompt/skill content manifests.** `resources/prompts/*.md` is generated from `docs/pi-prompt-templates/*.md` (the sole edit entry); `resources/skills/<name>/SKILL.md` is authored directly. Both get manifests with the same conventions as extensions: no timestamps, byte-identical output for identical input, package-level version bumped via `--set-version`, per-file sha256 as the update criterion.

## Important Files

| File | Role |
|---|---|
| `src/main/index.ts` | Composition root; window/tray/single-instance/lifecycle; `registerIpc()` at ~line 2316; `resolveBuiltInExtensionRoots()`; `resolveImageGenStorageRoots()`. |
| `src/preload/index.ts` | The entire `PiDesktopApi` surface; `subscribe<T>()` helper returns unsubscribe. |
| `src/shared/ipc.ts` | All ~500 IPC channel constants. |
| `src/shared/types.ts` + `src/shared/types/*.ts` | Domain-split shared types (barrel kept for compatibility). |
| `src/main/pi/AgentManager.ts` | pi agent lifecycle + event fan-out (largest module). |
| `src/main/sessions/SessionRuntimeCoordinator.ts` | `sessionId + agentId + runtimeGeneration` binding and stale-event rejection. |
| `src/main/pi/PiRpcClient.ts` | stdio JSONL RPC client; bounded line buffer (`MAX_RPC_LINE_BYTES` 8 MB). |
| `src/renderer/src/main.tsx` | Renderer entry; imports `./styles.css`; global error → log + toast. |
| `src/renderer/src/App.tsx` | Top-level shell (size debt — do not grow). |
| `src/renderer/src/styles.css` | Cascade layer declaration + legacy/vendor imports. |
| `src/renderer/src/desktopApi.ts` | Renderer's single door to the main process. |
| `electron.vite.config.ts` | Three-target build; main `lib.entry` set (stable filenames); aliases; `shiki` → fine bundle; KaTeX font pruning. |
| `electron.vite.main.mjs` | main+preload-only rebuild; entries must stay identical to the main config (guarded by `tests/dshMainEntries.test.mjs`). |
| `tsconfig.json` (+ `.main/.preload/.renderer`) | Strict TS config; `typecheck` also covers `docs-site/.vitepress/*.ts`. |
| `biome.jsonc` | Formatter baseline (tab / lineWidth 320 / double quotes / LF). |
| `playwright.config.ts` | E2E config: `testDir ./e2e`, `workers: 1`, 60s timeout. |
| `e2e/fixtures.ts` | Electron app fixture; temp `userData` per worker; `seedProjects`/`seedSettings`; `PIDEK_E2E_EXECUTABLE_PATH` for packaged runs. |
| `e2e/mock-pi.cjs` | Minimal stdio JSON-RPC pi stub (streaming, abort) for agent-flow specs. |
| `.github/workflows/ci.yml` | Blocking gates (see below). |
| `.githooks/pre-push` → `scripts/atomgit-mirror.mjs` | Mirrors pushed refs to AtomGit; best-effort, never blocks push. |

## Runtime/Tooling Preferences

- **Runtime: Node.js 24** (CI pins `24.13.0`). No Bun, no Deno — scripts are plain `node`/`npm`.
- **Package manager: npm** with `package-lock.json` (CI uses `npm ci`). A `postinstall` script fixes node-pty permissions; `prepare` installs the git hooks (both idempotent, both best-effort).
- **Electron 43.4.0**, React 19, Vite 7, electron-vite 4, TypeScript 5.9, Jotai 2, Tailwind 4, biome 2.3.11, Playwright 1.62. (The README badge still says Electron 38 — trust `package.json`.)
- **Native modules** (`node-pty`, `koffi`, `sharp`, `sql.js` wasm) require `asarUnpack` entries and permission fixes; new native deps must update both.
- **Dev isolation:** `npm run dev` uses `<userData>-dev`; branches outside `main/master/dev/develop` get a branch-suffixed data dir and a hashed Vite port (shared branches keep 5181, others 5182–5281). `--user-data-dir=` still wins (E2E relies on it). Electron sandbox is off in dev on Linux unless `PIDECK_DEV_ENABLE_SANDBOX=1`; it is controlled by the `electronChromiumSandbox` setting in production and requires a full app restart to change.
- **Useful env switches:** `PIDECK_DEV_BRANCH`, `PIDECK_DEV_VITE_PORT`, `PIDECK_DSH_RUNNER_NODE`, `PIDECK_MEMORY_PROFILE` (+`_INTERVAL_MS`), `PIDECK_DEV_BUILD`, `PIDECK_RELEASE_TAG`, `PIDEK_E2E_EXECUTABLE_PATH`, `PI_DECK_ATOMGIT_*` (`SKIP`/`STRICT`/`REMOTE`/`URL`/`DRY_RUN`).
- **Cross-platform is mandatory.** Never hardcode `/` or `\`; shell detection, external editors, and git lookup must cover win/mac/linux including WSL (`src/main/wsl/`, `wslExe`/`WslPaths`). Platform workarounds live in dedicated modules (e.g. `src/main/linuxDisplayBackend.ts`), not scattered through business code.
- **Electron lifecycle gotchas:** `appendSwitch`, `setPath("userData")`, and single-instance checks must happen before `app.whenReady()` — there is no fixing them later. Single-instance uses a custom per-version lock (`acquireVersionSingleInstance`), not `requestSingleInstanceLock`, so different versions can coexist. Quit must clean up pi children, node-pty, file watchers, and the lock file.
- **Webview (browser panel):** dedicated partition, forced `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, dangerous params (`preload`, `allowpopups`) stripped by `configureBrowserPanelWebviewHost`; `did-attach-webview` validates the guest session; navigation is whitelisted at `will-frame-navigate`, `will-redirect`, **and** `setWindowOpenHandler`.
- **`setWindowOpenHandler`** must be registered on both the main window and webview guests, routing through `openExternalUrl` and denying — a missing registration lets users open unmanaged windows.

## Testing & QA

**Framework:** `node --test` with `tests/*.test.mjs` (751 files). Default concurrency 4 (`npm test`); CI runs serial with `--test-timeout=120000 --test-force-exit` because concurrent runs share process globals and intermittently hang on the Windows runner.

**Gates before merge:** `npm run typecheck` plus the targeted test files for the change (`node --test tests/<related>.test.mjs`). Run the full `npm test` only for broad changes (IPC / session chain / assembly) or as a final pre-merge check. Never "merge then fix".

**When tests are required:**

- Bug fix → write the reproduction test first (red), then fix to green; keep the regression test permanently.
- New main-process business logic (sessions/git/settings/extensions/prompts/…) → unit tests mandatory.
- New data transformation / parsing / state machine → unit tests mandatory.
- Pure UI layout tweaks are not forced, but hooks with interaction state transitions should be tested.

**Loading production TS modules — use the existing helpers, never a hand-written `vm` loader:**

- `tests/helpers/loadTsCommonJs.mjs` — `loadTsCommonJs(filePath, { stubs })`; loads the full dependency graph through a CommonJS VM with relative imports resolved **against the source file's directory**. Use for whole modules. Example (`tests/agentHistoryLoadFreeze.test.mjs`):

  ```js
  import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
  const { trimHistoryMessages } = loadTsCommonJs("src/main/pi/agentUtils.ts");
  ```

- `tests/helpers/createTsSandbox.mjs` — `createTsSandbox({ stubs, globals, compilerOptions })` returns `load("src/main/x.ts")`; keeps a per-instance module cache (so circular deps behave like Node) while letting you inject `process`/timers/custom globals.

Both resolve relative imports from the source file. The classic failure they replace is a hand-written sandbox falling back to `require(specifier)`, which resolves from `tests/` — so adding one local import to production code breaks a whole group with a misleading `MODULE_NOT_FOUND` pointing at the test file. Helper modules `tests/helpers/mainIpcSources.mjs` (all `src/main/index.ts` + `src/main/ipc/*.ts` source concatenated, used by ~3 tests) and `tests/helpers/rendererStyles.mjs` (legacy CSS concatenated in cascade order, used by ~40 tests) exist for source-contract assertions.

**Test style:** one assertion per test, name states intent (e.g. `agentCreateTimeout.test.mjs`, `composerAutoGrow.test.mjs`). Assert behavior through public interfaces / IPC boundaries — never internal private call counts. No dependence on execution order, real network, or a real pi process (use `stubs`). **Forbidden:** loosening assertions to pass, commenting out failing tests, making tests tautological.

**E2E:** `npm run test:e2e` runs `build:fast` then `playwright test` against `out/main/index.js` (no Vite dev server). Each worker gets a temp `userData` (Windows `APPDATA`, Linux `XDG_CONFIG_HOME`, macOS `HOME`) so local data is untouched. Specs that don't start pi need no mock; agent flows use `e2e/mock-pi.cjs`. `e2e/startupOverlays.ts` disarms the auto-appearing command-palette onboarding dialog (it steals focus and intercepts pointer events, masquerading as business failures) — call it before strict-timing assertions. Real-pi scenarios are explicitly outside the default gate. Packaged-binary verification sets `PIDEK_E2E_EXECUTABLE_PATH`.

**CI (`.github/workflows/ci.yml`, `windows-latest`) — all blocking, in order:**

1. `npm ci`
2. Drift guards: `check:announcements` + `check:pi-ai-catalog` + `check:extensions-manifest` + `check:prompts-manifest` + `check:skills-manifest` — deliberately **before** the build, since the build chain silently regenerates manifests and would mask committed drift. (`check:xueprompts` is already inline in `npm run build`.)
3. `npm run check:format`
4. `npm run test:serial -- --test-timeout=120000 --test-force-exit`
5. `npm run make-icon`
6. `npm run typecheck`
7. `npm run build`
8. `npm run pack`

A second job (`pet-linux-smoke`, `ubuntu-latest`) runs `npm run build` then `xvfb-run -a npx electron --no-sandbox scripts/pet-smoke.cjs`.

`restrict-main-pr.yml` closes PRs to `main` from non-members — **external PRs target `dev`**. `release.yml` is `workflow_dispatch`-driven with a static tag dropdown plus a `tag_custom` fallback; `scripts/sync-workflow-choices.js --check` keeps that list aligned with the CHANGELOG.

**Invariant-guard tests (do not break these):**

| Test | Guards |
|---|---|
| `cssCascadeLayers.test.mjs` | `vendor < legacy < utilities` layer order and `layer()` imports |
| `docsSharedImages.test.mjs` | `docs/images` single source, gitignored copies, path prefixes, hard failure on missing source |
| `dshMainEntries.test.mjs` | `electron.vite.config.ts` main entries cover every `join(__dirname, "<name>.js")` reference |
| `extensionPackagingDeps.test.mjs` | extension bare imports ↔ `extraResources` / `VENDOR_DEP_PACKAGE_NAMES` parity |
| `ipcDeadChannelConstants.test.mjs` | no channel constants without handler/preload references |
| `afterPackCleanup.test.mjs` / `afterPackSharpPatch.test.mjs` | `afterPack` never deletes runtime-required files |
| `piAiCatalogPackaging.test.mjs` | catalog + manifest shipped together |
| `syncWorkflowChoices.test.mjs` | release dropdown ordering, sentinel, `v` prefix |
| `xuePromptOverlay.test.mjs` / `xuePromptSearch.test.mjs` | overlay resolution and application-layer gzip search |
| `mainProcessI18n.test.mjs` / `rendererProductCopyI18n.test.mjs` | main/renderer copy keys exist and interpolate; no hardcoded copy |
| `storeSuggestionChipContrast.test.mjs` | no `text-<surface token>` in the renderer |
| `sessionRuntimeTargetBoundaries.test.mjs` | runtime commands carry the `sessionId/agentId/runtimeGeneration` triple |
| `dshRuntimeIpc.test.mjs` | subscription APIs return unsubscribe |
