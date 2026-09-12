# Local Player — Technical Documentation

**English** | [Português](pt-br/DOCUMENTACAO.md)

Central technical reference. Written directly against actual code (`server.js`, `public/`, `package.json`, `test/`) — code is the source of truth. For user-facing setup, refer to `README.md` (or `README.pt-BR.md`). Specialized subsystem guides: `docs/SUBTITLES.md` (AI subtitles), `docs/whisper.md` (Whisper setup), and `docs/VALIDATION.md` (validation checklist).

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Directory Layout and Runtime Data](#3-directory-layout-and-runtime-data)
4. [Scan and Content Tree](#4-scan-and-content-tree)
5. [Explicit Topic Markers](#5-explicit-topic-markers)
6. [External Libraries](#6-external-libraries)
7. [Title Normalization](#7-title-normalization)
8. [Security](#8-security)
9. [REST API](#9-rest-api)
10. [Progress Persistence](#10-progress-persistence)
11. [Fallback Transcoding](#11-fallback-transcoding)
12. [AI Subtitles](#12-ai-subtitles)
13. [Frontend](#13-frontend)
14. [Environment Variables](#14-environment-variables)
15. [Architectural Invariants](#15-architectural-invariants)

---

## 1. Overview

**Local Player** is a local/offline media player (Node.js + Express + vanilla HTML/CSS/JS SPA, **no build step**) that reads video media directly from disk. A single orchestrator backend (`server.js`) scans libraries, serves a JSON API, delivers raw files via HTTP Range requests, and coordinates transcoding and AI subtitles; the frontend (`public/`) is a zero-build client communicating over standard HTTP. Operates at `http://localhost:4173`.

Core repository files:

| File / Folder | Role |
| --- | --- |
| `server.js` | Main backend orchestrator: route coordination, API endpoints, media streaming, and lifecycle management |
| `server/` | Decoupled backend modules (`core/`, `services/`, `ai/`) without build steps |
| `public/index.html` | SPA host shell (topbar + `<main id="app">`) |
| `public/app.js` | SPA orchestration, hash routing, and primary views (Home, Course, Topic) |
| `public/js/` | Decoupled client modules (`player`, `subtitles`, `tutor`, `study`, `settings`, `shortcuts`, `editor`) |
| `public/scope.js` | Pure scoped navigation and progress helpers (reusable in test suites) |
| `public/styles.css` | Stylesheet (dark theme, responsive mobile/desktop layout) |
| `test/` | Automated test suite powered by `node:test` |

Single runtime production dependency: **Express** (`package.json`). FFmpeg and FFprobe are optional system binaries for on-the-fly transcoding and audio extraction.

---

## 2. Architecture

Primary data flow:

```text
init() → GET /api/tree + GET /api/progress → state → hash router
renderCourse → select lesson (resume rule) → <video src="/media/<rel>">
tracking (timeupdate 5s / pause / ended / beforeunload) → POST /api/progress
→ updateProgress (serialized queue) → writeFileAtomic (atomic replace with backup)
video playback error → prepareTranscoded → /api/video/fallback → /transcoded/<hash>.mp4
mount player → setupPlayerSubtitles → status → overlay + badge + button; never blocks play()
```

- Backend and frontend communicate strictly via standard HTTP (`/api/*`, `/media/*`, `/transcoded/*`).
- Client-side navigation is hash-based (`#/`, `#/settings`, `#/course/...`, `#/topic/...`).
- 100% local execution; the only network request ever performed is optional user-configured LLM testing or web search.

---

## 3. Directory Layout and Runtime Data

```text
Library/                     ← ROOT (parent of app directory; default library root)
├── Course A/
└── _LocalPlayer/            ← application folder
    ├── server.js, package.json, README.md, AGENTS.md
    ├── electron-main.js     ← native Electron wrapper
    ├── server/              ← decoupled backend modules (core/, services/, ai/)
    ├── public/              ← SPA (index.html, app.js, scope.js, styles.css)
    │   └── js/              ← decoupled SPA components
    ├── data/                ← local runtime data (gitignored)
    │   ├── progress.json (+ .bak, .corrupt-<ts>, orphan .tmp cleanup)
    │   ├── libraries.json   ← library registry
    │   ├── ai-config.json   ← AI settings (API keys strictly stored here)
    │   ├── transcoded/      ← video transcoding cache
    │   └── subtitles/       ← raw/, processed/, edited/, jobs.json, <hash>.vtt
    ├── test/                ← node:test suite
    └── docs/                ← technical documentation
```

- `ROOT = path.resolve(__dirname, "..")` — derived from app location, never hardcoded. `APP_DIR_NAME` is ignored during library scans.
- `data/` can be redirected via `LP_DATA_DIR` (used in test sandboxes).
- `bin/` and `models/` (gitignored) hold local Whisper binaries and GGML models.
- The server does not write logs to files; technical logs are kept in a circular memory buffer accessible via `GET /api/logs`.

---

## 4. Scan and Content Tree

The scanner (`scanDir`/`scanLibrary`) transforms filesystem paths into structured tree nodes:

```js
{ type: "folder", name, path, title, children, videoCount, coverImage }  // course / module
{ type: "topic",  name, path, title, children, videoCount, coverImage }  // marked topic folder
{ type: "video",  name, path, ext, size, title }                          // playable lesson
{ type: "file",   name, path, ext, size }                                 // non-video support material
```

Scanning rules:
- Exclusions: application directory (only on default library root), dotfiles/dot-directories, ignored extensions (`.ini`, `.db`, `.lnk`).
- Video extensions (`VIDEO_EXT`): `.mp4`, `.mkv`, `.webm`, `.mov`, `.avi`, `.m4v`, `.wmv`.
- Natural sorting: `localeCompare(..., "pt-BR", { numeric: true, sensitivity: "base" })`.
- Tree cache: Map per library in memory and persisted to `data/tree-cache-<libId>.json` for instant startup.

### Covers

`pickCoverImage` scans directory images for hints matching `COVER_NAME_HINTS` (`cover`, `thumbnail`, `poster`, `banner`, `image`, `img`). `chooseCoverImage` allows inheriting covers from child folders. Missing images fall back to styled gradients with initials in the UI.

---

## 5. Explicit Topic Markers

Classification is strictly **explicit with zero structural guesswork**:

> A folder is a **topic** if it contains a `.topic` file **or** its filesystem name ends with `(TP)` (case-insensitive regex `\(TP\)\s*$`). Otherwise, it is a `folder` (course or module).

- The `.topic` marker is a dotfile and never appears in trees, search, or counts.
- `(TP)` and leading numbers are stripped strictly from visual display titles; the underlying folder `name` is never mutated.
- The marker overrides direct files: a folder containing both `.topic` and `video.mp4` remains a topic.

---

## 6. External Libraries

Configured in `data/libraries.json` (`{ libraries: [{ id, name, path, enabled, isDefault, createdAt }], updatedAt }`).
- The **default library** (`id = "default"`) has an immutable path (`ROOT`).
- External libraries use random UUIDs (resilient to renaming).
- **Path validation** (`validateLibraryPath`): requires absolute path, resolves realpath, rejects forbidden folders (`__dirname`, `public/`, `node_modules/`, `data/`), and forbids nesting inside existing libraries.
- **Key scoping**: progress uses `libId\0rel`; caches use `sha1(libId\0rel)[0:24]`.
- Library deletion is strictly **config-only**: files on disk are never deleted.

---

## 7. Title Normalization

`normalizeDisplayTitle` executes on the server:
- Underlying `name` is preserved untouched for sorting and filesystem operations.
- Strips symbolic prefixes, labels (`Lesson 03 - `), author suffixes, and leading numbering.
- Sentence casing preserves recognized abbreviations (SQL, Python, Node.js, TI).
- Modules preserve numbering; topics and lessons remove leading digits.

---

## 8. Security

- **Path Traversal Protection**: client paths resolve through `resolveSafeRelPath()` and `resolveLibraryRel()`, guaranteeing paths remain bounded within the authorized library.
- **Symlink Protection**: `fileWithinLibrary()` performs `fs.realpath` verification on both target and library directory, blocking symlink escapes.
- **Active Material Isolation**: support files with executable potential (`.html`, `.htm`, `.xhtml`, `.svg`, `.xml`, `.js`, `.mjs`, `.json`) are served as downloads with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
- **Transcode Route Validation**: `/transcoded/*` enforces strict regex `^[0-9a-f]{24}\.mp4$`.
- **Protected Secrets**: AI credentials remain strictly in `data/ai-config.json` and are masked in API outputs.
- **Anti-CSRF & Safe Origin**: mutating routes require matching Host/Origin headers and block `Sec-Fetch-Site: cross-site`. Administrative routes enforce `requireAdminOrLocal`.
- **Anti-SSRF Protection**: Web search blocks private IP ranges, cloud metadata addresses (`169.254.169.254`), non-standard ports, and pins DNS resolution to prevent rebinding attacks.

---

## 9. REST API

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/tree?rescan=1` | Cached library trees (`rescan=1` forces fresh scan) |
| `POST` | `/api/rescan` | Rescan all libraries and queue P2/P3 subtitle tasks |
| `GET` | `/api/libraries` | List registered libraries |
| `POST` | `/api/libraries` | Register external library (`requireAdminOrLocal`) |
| `PATCH` | `/api/libraries/:id` | Update library settings (`requireAdminOrLocal`) |
| `DELETE` | `/api/libraries/:id` | Unregister library (`requireAdminOrLocal`) |
| `POST` | `/api/libraries/:id/rescan` | Rescan specific library |
| `GET` | `/api/progress` | Retrieve all playback progress entries |
| `POST` | `/api/progress` | Save lesson progress |
| `POST` | `/api/progress/clear` | Clear progress by prefix or globally (`requireAdminOrLocal`) |
| `GET` | `/media/*` | Stream original media with HTTP Range support |
| `GET` | `/api/video/fallback?path=` | Retrieve transcoding playback plan |
| `GET` | `/transcoded/<24-hex>.mp4` | Stream transcoded cache |
| `POST` | `/api/transcode/clear` | Clear transcoding cache (`requireAdminOrLocal`) |
| `GET` | `/api/ai/status` | Live status of AI providers |
| `GET` | `/api/ai/config` | Masked AI configuration |
| `POST` | `/api/ai/config` | Update AI configuration (`requireAdminOrLocal`) |
| `POST` | `/api/ai/reset` | Reset AI configuration (`requireAdminOrLocal`) |
| `POST` | `/api/ai/llm/test` | Test LLM endpoint (`requireAdminOrLocal`) |
| `GET` | `/api/storage/status` | Storage usage breakdown |
| `GET` | `/api/system/status` | System and device operational status |
| `GET` | `/api/logs` | Technical logs in circular memory buffer |

---

## 10. Progress Persistence

Progress is persisted directly to `<lib.path>/.courseplayer/progress.json` within each library, making progress portable across external drives. A consolidated mirror is maintained in `data/progress.json`.

Durability guarantees:
- **Atomic Writes**: unique temporary file $\rightarrow$ `fsync` $\rightarrow$ atomic `rename` $\rightarrow$ directory `fsync`.
- **Serialized Queue**: `updateProgress` sequences write operations in promises, draining cleanly on shutdown.
- **Backup & Auto-Recovery**: `progress.json.bak` stores pre-modification states; corrupted files are preserved as `.corrupt-<ts>` while state is restored from backup.
- **Anti-Regression Safeguards**: normal saves never discard existing keys, never regress valid duration/position, and never clear completed states without explicit toggle.

---

## 11. Fallback Transcoding

Triggered only after a video playback `error` event:
- Direct playback for native codecs (H.264, VP8, VP9, AV1 with AAC, MP3, Opus, Vorbis, FLAC).
- On-the-fly progressive transcoding for unsupported codecs into fragmented MP4.
- Concurrency managed via FIFO queue and shared semaphore slots.

---

## 12. AI Subtitles

- Multi-priority queue (P0 demand, P1 next lesson, P2 first lesson, P3 background).
- Dedicated audio extraction to 16kHz mono PCM16 WAV.
- Canonical WebVTT saved inside `.courseplayer/subtitles/<hash>.vtt`.
- For complete technical documentation, see [`docs/SUBTITLES.md`](SUBTITLES.md).

---

## 13. Frontend

- Vanilla JS SPA without compilation steps.
- Hash-based navigation (`#/`, `#/course/...`, `#/topic/...`, `#/settings`).
- Web Audio API GainNode amplification up to 300% with transparent native DynamicsCompressorNode normalizer.
- Responsive mobile drawer and landscape optimization (`max-height: min(72svh, 780px)`).

---

## 14. Environment Variables

All variables are optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4173` | Web server port |
| `HOST` | all interfaces | Network binding interface |
| `LP_DATA_DIR` | `data/` | Runtime directory redirect (used in test sandboxes) |
| `FFMPEG_BIN` / `FFPROBE_BIN` | `ffmpeg` / `ffprobe` | Custom binary paths |
| `MAX_CONCURRENT_TRANSCODES` | `1` | Max concurrent video conversions |
| `MAX_CONCURRENT_AI_JOBS` | `1` | Shared heavy slots limit (transcode + whisper) |
| `WHISPER_BIN` / `WHISPER_MODEL_DIR` | `bin/` / `models/` | Whisper binary and model directory |
| `LP_PROGRESS_FORENSIC` | disabled | Detailed progress write instrumentation |
| `LP_IDLE_TIMEOUT_MINUTES` | `30` | Inactivity shutdown timeout in minutes (`0` = disabled) |

---

## 15. Architectural Invariants

- `ROOT` derives from `__dirname`; all paths validate against traversal and library bounds.
- Library unregistration is config-only (zero disk deletion).
- Supplementary files with active content are served strictly with `attachment` and `nosniff`.
- AI subtitles and transcoding are non-blocking and never delay playback.
