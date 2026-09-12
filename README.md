# Local Player

**English** | [Português](README.pt-BR.md)

Local/offline player in Node.js + Express (single orchestrator backend `server.js`, pure JS SPA in `public/`, **no build step**) to organize and play disk media — modules, trainings, courses, and video libraries on **Linux**. Reads everything directly from local or external storage (HDD, SSD, USB flash drive, SD card), with zero telemetry and without sending anything to the internet.

## Features

- **Instant Boot and Concurrent Scan**: persistent on-disk tree cache (`data/tree-cache-<libId>.json`) and parallel directory scanning with controlled concurrency, loading libraries with thousands of lessons in milliseconds even on USB flash drives or external drives.
- **Terminal-Free Background Run & System Shortcuts (Linux)**: decoupled background startup (`setsid`), without hanging terminal windows. Optional native desktop integration with application menus and desktop launchers (GNOME, KDE, XFCE) with sharp SVG/PNG icons following the FreeDesktop specification (`.desktop` and `hicolor`).
- **Hierarchical Topics**: folders declared as topics (`.topic` marker file or folder name ending in `(TP)`) become breadcrumb navigation pages (`Home › IT › Python`).
- **Smart Cover Cards**: automatic covers detected by image name hints or inherited from child modules; generates a gradient with initials if no image is present.
- **Subtle Visual Dimming for Completed Modules**: courses and modules with all lessons finished become discretely dimmed, keeping visual focus on pending learning material.
- **Global & Contextual Search**: instant search for topics, modules, lessons, and auxiliary files with accent-insensitive flexible matching.
- **Robust Player with Persistent Progress**: atomic position saving, intelligent auto-resume, and automatic lesson completion when watching >95% of the video.
- **Audio Boost, Deep Normalizer & Controls**: volume amplification up to 300% via Web Audio API (GainNode) for quiet recordings; built-in deep normalizer (pre-gain + DynamicsCompressorNode at -34 dB + anti-clipping limiter at -1 dB) that rescues low voices and evens speech without distortion; persistent playback speed (0.5× to 2×); theater mode; native fullscreen; configurable keyboard shortcuts.
- **Sidebar for Lessons & Materials**: sidebar focused strictly on lesson navigation; supplementary files (.pdf, .zip, .docx, code) stay neatly isolated under the "Lesson materials" drawer.
- **Transparent Fallback Transcoding**: native formats play directly via HTTP Range; progressive real-time fallback transcoding using FFmpeg only if the browser does not natively support the file's codec.
- **Configurable Multi-Library**: register external folders or mounted drives (Settings → Libraries) with full key isolation (`libId\0rel`), dedicated on-device backups, and support for disabled libraries without unmounting.
- **Automated AI Subtitles**: offline audio transcription powered by **whisper.cpp**, multi-tier priority queue (P0 to P3), deterministic post-processing, and resilient recovery against crashes.
- **Integrated AI Tutor with Web Search**: real-time study assistant via streaming chat (SSE) with automatic lesson context (transcription, interactive timestamps, and zero-dependency text extraction from PDFs, Office docs, and source code), safe web search with anti-SSRF protection, token-efficiency skills (Caveman, RTK, Headroom), and actionable response formatting (ADHD).
- **AI Quizzes & 3D Flashcards**: automated generation of multiple-choice tests with instant feedback and 3D flip repetition flashcards based on lesson content.
- **Responsive Interface**: full support for desktop, tablet, and mobile smartphones with a slide-out lesson drawer.

---

## Choose How to Use

You can run Local Player in two ways: by downloading the pre-packaged standalone Linux executable (**AppImage**) or by running directly from source (**Web / Node.js**).

---

## Standalone Linux AppImage

The easiest and recommended way for Linux desktop users — no need to install Node.js or compile dependencies:

1. Visit [Releases](https://github.com/IPauloGermano/local-player/releases) and download `LocalPlayer.AppImage`.
2. Grant execute permission and run:
   ```bash
   chmod +x LocalPlayer.AppImage
   ./LocalPlayer.AppImage
   ```

> **Offline AI & Whisper**: To use automated offline subtitles in the AppImage, place your Whisper ggml models (e.g. `ggml-small.bin`) inside a `models/` directory next to the `LocalPlayer.AppImage` executable or configure the `WHISPER_MODEL_DIR` environment variable. Large binary files and models are never committed to the git repository.

### Building and Publishing New Releases (AppImage)

For developers who wish to compile and package the AppImage from source:
```bash
npm run dist
gh release create vX.Y.Z dist/LocalPlayer.AppImage --title "vX.Y.Z" --notes "Release notes"
```

---

## Run from Source (Web / Node.js)

For users and developers who prefer running the local HTTP server and accessing through a web browser:

### Requirements
- **Operating System**: Linux (Fedora, Ubuntu, Debian, Arch Linux, openSUSE, etc.).
- **Node.js**: 18+.
- **Modern Browser**: Firefox, Chrome, Chromium, Brave, Edge.
- **FFmpeg / FFprobe (optional)**: only required for fallback transcoding of incompatible codecs and audio extraction for subtitles.
- **Whisper.cpp (optional)**: only required for local AI subtitle generation (see `docs/whisper.md`).

### Installation

The application folder should be placed inside a directory whose **parent is the root of the default library** (the library root is derived from the app's location, never hardcoded):

```text
My Library/
├── Module A/
├── Module B/
└── _LocalPlayer/          ← app directory (any folder name)
```

```bash
npm install --no-bin-links   # --no-bin-links helps on external FAT/exFAT drives
```

### Running

You can launch Local Player using the following options:

#### Option 1: Foreground Terminal (Web)
```bash
npm start                    # starts server on http://localhost:4173
```
`PORT` and `HOST` override port and network interface (default binds to all interfaces; use `HOST=127.0.0.1` to restrict to localhost).

#### Option 2: Detached Background Run (No terminal window)
```bash
./local-player.sh            # or: npm run start:bg
```
To gracefully stop the background server:
```bash
./stop.sh                    # or: npm run stop
```

#### Option 3: Native Desktop Mode (Electron window)
```bash
npm run start:desktop        # launches the integrated Electron desktop application
```

---

### System Application Shortcut (Optional)

Creating a system launcher shortcut is **100% optional** and is never forced automatically:

- **Via Web Interface**: Open **Settings → General** inside the app and click **Create System Shortcut** (or **Remove Shortcut**).
- **Via Terminal**:
  - Install to application menu and desktop:
    ```bash
    ./instalar-atalho.sh     # or: npm run shortcut:install
    ```
  - Uninstall and clean system icons:
    ```bash
    ./remover-atalho.sh      # or: npm run shortcut:remove
    ```

The installer creates `localplayer.desktop` in `~/.local/share/applications/`, distributes high-res SVG and PNG icons across the `hicolor` icon theme hierarchy, and updates the desktop environment database (GNOME, KDE, etc.).

---

## Configuration (Environment Variables)

All environment variables are optional:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `4173` | HTTP server port |
| `HOST` | all interfaces | Network interface for listening |
| `FFMPEG_BIN` / `FFPROBE_BIN` | `ffmpeg` / `ffprobe` in PATH | Path to FFmpeg binaries (spaces supported) |
| `MAX_CONCURRENT_TRANSCODES` | `1` | Concurrent video transcoding limit |
| `MAX_CONCURRENT_TRANSCRIPTIONS` | `1` | Concurrent Whisper transcription limit |
| `MAX_CONCURRENT_AI_JOBS` | `1` | Shared heavy slots semaphore (transcoding + whisper) |
| `BACKGROUND_SUBTITLE_GENERATION` | AI Center config | `true`/`1` enables automatic P3 background generation |
| `WHISPER_BIN` / `WHISPER_MODEL_DIR` | `bin/` / `models/` | Whisper binary and models directory |
| `LP_DATA_DIR` | `data/` | Redirects runtime data directory (used in test sandboxes) |
| `LP_NO_BROWSER` | (disabled) | `1` prevents automatic browser launch on startup |
| `LP_PROGRESS_FORENSIC` | (disabled) | `1` enables verbose forensic progress persistence logs |
| `LP_IDLE_TIMEOUT_MINUTES` | `30` | Minutes of inactivity without tabs before auto-shutdown (`0` = disabled) |

---

## Quick Start & Shortcuts

1. Open Home and click on a course or topic.
2. Inside a course, use the sidebar to select a lesson.
3. Your playback position is saved atomically and resumed accurately when you return.
4. Click the **⟳ Refresh** button on the topbar whenever you add or modify files on disk.
5. **Default Keyboard Shortcuts**:
   - `Space`: Play / Pause
   - `←` / `→`: Rewind / Fast forward 5 seconds
   - `J` / `L`: Rewind / Fast forward 10 seconds
   - `N` / `P`: Next lesson / Previous lesson
   - `M`: Mute / Unmute
   - `,` / `.`: Decrease / Increase playback speed
   - `F`: Fullscreen toggle
   - `T`: Theater mode toggle
   - `/`: Focus search input
   - `H`: Navigate to Home
   *(All customizable in Settings → Shortcuts)*.

---

## Topics vs Courses

A folder is classified as a **topic** explicitly and predictably:
- It contains a `.topic` marker file, **or**
- Its folder name ends with the suffix `(TP)` (case-insensitive, e.g., `Programming (TP)`).

Topics open hierarchical navigation cards with breadcrumbs. The `(TP)` marker and leading numbering are stripped only from the visual displayed title in the interface.

---

## External Libraries

In **Settings → Libraries**, you can register extra directories using absolute paths (external HDDs, USB sticks, or other local folders).
- Paths are validated against nesting, symlink escapes, and application directory collisions.
- Progress keys, favorites, and caches are strictly isolated per library (`libId\0rel`).
- Disabled libraries remain visible for quick re-enabling or removal without file locking.
- Removing a library is strictly **config-only**: no files are deleted from disk.

---

## AI Subtitles

The player transcribes audio using local **whisper.cpp** in a non-blocking background queue:
1. 16kHz mono PCM16 audio extraction using FFmpeg.
2. Transcription using dynamically computed optimal CPU threads.
3. Deterministic post-processing.
4. **Resilience**: action button with forced restart (`force=1`), orphan job cancellation, and clear diagnostic messages if binaries or models are missing.

*See `docs/whisper.md` and `docs/SUBTITLES.md` for complete technical details.*

---

## AI Tutor, Quizzes, and Flashcards

In the Player's side drawer, you have access to integrated AI study tools:
- **AI Tutor**: ask questions about the current lesson with real-time SSE streaming. The assistant automatically receives the lesson title, hierarchy, transcription, supplementary materials (zero-dependency text extraction for PDF, Word, PowerPoint, RTF, and code files), and safe web search against outdated knowledge.
- **AI Skills**:
  - *Caveman*: concise, token-efficient direct answers.
  - *RTK*: noise and log filtering on large support materials.
  - *Headroom*: structured context compression and code minification.
  - *ADHD*: actionable formatting (action first, numbered steps, concrete next step).
- **Quizzes**: generate multiple-choice assessments with instant correction and explanations based on lesson materials.
- **3D Flashcards**: memorize key concepts with interactive 3D flipping cards.

---

## Security and Privacy

- **100% Local**: zero telemetry, tracking, or cloud runtime dependency.
- **Anti-CSRF & Safe Origin Protection**: mutating and administrative endpoints (progress reset, transcoding clear, system shortcuts, AI config) require strict same-origin verification (`Sec-Fetch-Site: same-origin` / `same-site`) and matching `Host` and `Origin` headers.
- **Anti-SSRF Protection on Web Search**: strict blocking against requests to private, loopback, and cloud metadata IP ranges (RFC 1918, `127.0.0.0/8`, link-local `169.254.0.0/16`, CGNAT `100.64.0.0/10`, IPv6 `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped IPv6, 6to4 tunnels) and non-web ports.
- **Path Traversal Protection**: all media and static routes resolve canonical paths ensuring zero escape from the authorized library root or application directory.
- **UI Path Sanitization**: absolute filesystem paths displayed in the frontend mask the user's home directory with `~` to protect local filesystem privacy.
- **Material Isolation**: supplementary files with potentially active content (HTML, JS, SVG, JSON) are served as downloads with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` headers.
- **Protected API Keys**: AI provider credentials are stored strictly on the server (`data/ai-config.json`), are masked in APIs (`hasApiKey: true`), and are never printed in logs.

---

## Development and Testing

- **Zero Build Step**: edit `server.js` or files in `public/` and reload your browser.
- **Syntax Check**:
  ```bash
  node --check server.js public/app.js public/scope.js public/js/*.js server/*.js server/**/*.js
  ```
- **Automated Test Suite (155 tests)**:
  ```bash
  npm test
  # or directly:
  node --test test/*.test.js test/*-smoke.js
  ```
- **Validation Checklist**: see `docs/VALIDATION.md` for the full release validation steps.

---

## Project Structure

- `server.js` — Main backend orchestrator (scans with disk cache, REST API, HTTP Range media streaming, atomic persistence, FFmpeg fallback, Whisper pipeline, Tutor routes, and system shortcut integration).
- `electron-main.js` — Native Electron desktop application entry point (`asar: false`, hardened context isolation).
- `server/` — Decoupled backend modules (`core/`, `services/`, `ai/`).
- `public/` — Zero-build SPA in vanilla JS/CSS (`index.html`, `app.js`, `scope.js`, `styles.css`, `favicon.svg`, `favicon.png`).
- `public/js/` — Modular SPA components (`player`, `subtitles`, `tutor`, `study`, `settings`, `shortcuts`, `editor`).
- `assets/` — Application icon assets in SVG and PNG formats.
- `local-player.sh` — Decoupled background startup script for Linux (no open terminal).
- `instalar-atalho.sh` / `remover-atalho.sh` — FreeDesktop `.desktop` shortcut installation and removal scripts.
- `stop.sh` — Graceful background server shutdown script.
- `data/` — Local runtime data: `progress.json` (+ backups), `tree-cache-<libId>.json`, `ai-config.json`, `libraries.json`, `subtitles/`, `transcoded/`.
- `test/` — Automated test suite with `node:test` (unit, invariance, persistence, security, forensic, and runtime smoke).
- `docs/` — Technical documentation in English (`DOCUMENTATION.md`, `SUBTITLES.md`, `whisper.md`, `VALIDATION.md`).
- `docs/pt-br/` — Technical documentation in Portuguese (`DOCUMENTACAO.md`, `SUBTITLES.md`, `whisper.md`, `VALIDACAO.md`).
