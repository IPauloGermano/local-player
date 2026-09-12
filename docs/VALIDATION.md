# How to Validate Changes

**English** | [Português](pt-br/VALIDACAO.md)

Operational validation checklist. Execute the steps applicable to your changes. The automated test suite forms the baseline; manual checks verify actual user flows.

---

## 1. Automated Test Suite

```bash
node --check server.js electron-main.js public/app.js public/scope.js public/js/*.js server/*.js server/**/*.js
git diff --check
npm test
```

`progress`, `sidebar-runtime-smoke`, `progress-invariance`, `progress-persistence`, and `progress-forensic` spin up real test servers using a temporary sandbox (`LP_DATA_DIR`); the remaining tests are pure unit tests.

---

## 2. Manual UI Verification

Launch via `npm start` and verify:

- **Scan / Navigation**: Home screen renders cards; open courses and topics; accent-insensitive search finds courses, lessons, topics, and auxiliary materials.
- **Player**: Compatible native files play directly without transcoding; progress is saved (reloading preserves playback position); favorites toggle; shortcuts work; Settings modal opens.
- **Materials**: Support files appear in the drawer below the player; sidebar lists only lessons.

---

## 3. Fallback Transcoding

Test with an incompatible format (e.g. `.mkv` or `.avi`):

1. The player tries the original $\rightarrow$ displays a non-blocking preparation badge;
2. `[TRANSCODE] progress` appears in server console;
3. Output file is created in `data/transcoded/` (`.tmp` only renames to final after exit code 0);
4. Seeking beyond transcoded duration waits or responds with HTTP 416;
5. `POST /api/transcode/clear` clears the cache and cancels active jobs **without touching** `progress.json`.

---

## 4. Progress Persistence

- Write playback progress, kill the server (including during active writes) and restart $\rightarrow$ position is preserved (restored from `.bak` backup).
- Corrupt `progress.json` (or remove it) $\rightarrow$ on boot the damaged file is preserved as `.corrupt-<ts>` and the main state is restored from backup.
- Rescanning (`⟳ Refresh` / `POST /api/rescan`) **never** deletes progress keys.
- Explicit clear is the only action that removes progress entries.

---

## 5. Path Traversal and Library Isolation

- `/media/../../etc/passwd`, `/api/video/fallback?path=../../etc/passwd`, and Windows-style paths (`\`, `..\..\`, `C:\`, `D:\`) $\rightarrow$ return HTTP 404 or 400, never serving files outside the library.
- Two instances binding the same port $\rightarrow$ display a clear error message and exit cleanly.
- External library management: adding (invalid/nested/prohibited path $\rightarrow$ error), playback and persistence scoped by `libId\0rel`, deletion is config-only (active jobs $\rightarrow$ 409; default library cannot be deleted).

---

## 6. AI and Subtitles

- **With nothing installed**: `GET /api/ai/status` $\rightarrow$ accurately reports `available:false`; `GET /api/ai/config` hides raw keys; AI Center renders all 6 tabs.
- **Generation** (with whisper at `WHISPER_BIN`): `POST /api/subtitles/generate` $\rightarrow$ logs per pipeline step $\rightarrow$ raw file created $\rightarrow$ canonical VTT in `.courseplayer/subtitles/` and mirror in `data/subtitles/`. Duplicate POST requests deduplicate; `force=1` regenerates; touching the video mtime invalidates old raw cache.
- **P0–P3 Queue**: Opening a lesson queues P0; next lesson queues P1; after scan, lesson 1 of each course queues P2; background queue runs in P3. Never queues the entire library at once.
- **Concurrency**: Transcoding and Whisper share heavy slots (they do not run concurrently by default).

---

## 7. Topics and Scope

- Test library with nested `.topic`/`(TP)` and root courses: Home renders topic cards (explicit marker; `Project TP`, `(TP) Course`, and `Lesson TP` do not become topics); breadcrumbs work; opening a course inside a topic opens the player.
- Contextual Scope: "Your progress" / "Continue watching" are global on Home and scoped strictly to the subtree inside topics; `IT` does not match `IT2` (exact segment comparison).

---

## 8. Mobile and Desktop Layouts

- Mobile viewports (320–430px): Slide-out lesson drawer, compact header, single-line controls, zero horizontal overflow; pulling down at the top **does not** trigger pull-to-refresh (overscroll disabled), player maintains 16:9 ratio.
- Landscape / wide screens: Player respects vertical boundary (`72svh`) without dynamic resize during scrolling.
- Desktop: Fullscreen, theater mode, controls, subtitles, and layout work seamlessly.
- **Mobile screens $\le$ 600px**: Subtitle language selector resides **strictly in the ⋮ menu** (`pc-more-cc-group`); CC popover on the control bar does not open on narrow screens; CC status dot reflects state (generating/translating).
