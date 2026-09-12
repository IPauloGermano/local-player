# AI Subtitles — Full Pipeline Reference

**English** | [Português](pt-br/SUBTITLES.md)

> In-depth technical reference for the Local Player subtitle subsystem. Pipeline: `Video → audio extraction (FFmpeg → 16kHz mono PCM16 WAV) → local ASR (whisper.cpp) → raw transcript → deterministic post-processing → segmentation → WebVTT → cache → player overlay`. Generation is **strictly optional**: without binaries, models, or internet connection, the player works normally.

---

## Data-Driven Registry

The single source of truth; zero `if (provider === X)` conditionals in business logic:
- `AI_TRANSCRIPTION_PROVIDERS`: local whisper/whisper.cpp with `capabilities: { vad: false, wordTimestamps: false, threads: true }`, plus stubs for alternative engines.
- `AI_LLM_PROVIDER_TYPES`: `openai-compatible`, `chatEndpoint` = `/chat/completions`.
- `AI_LLM_PRESETS`: OmniRoute, OpenRouter, OpenAI, Custom.

Adding a provider is simply registering a new entry; the pipeline, UI, and API contracts remain untouched. **`capabilities.vad` is deliberately false**: whisper-cli 1.9.2 rejects the `-vad` short flag, while real VAD requires `-vm` with `ggml-silero-vad.bin` (not installed by default).

---

## Configuration

Stored in `data/ai-config.json` (atomic writes + serialized queue, matching `updateProgress`):
```json
{
  "transcription": { "provider": "whisper_cpp", "model": "small", "language": "pt", "enabled": true, "generateMode": "on-demand", "pregenFirstLesson": false, "pregenNextLesson": true, "background": false },
  "postprocessing": {},
  "llm": { "providers": [] },
  "advanced": { "maxConcurrentAiJobs": 1, "llmTimeoutMs": 30000, "transcriptionThreads": 0 }
}
```
- `maskAiConfig()` serializes API responses (returns `hasApiKey: true/false`, never raw keys).
- `applyAiPatch()` handles partial merges on `POST /api/ai/config`.
- `sanitizeAiConfig()` validates inputs against the registry.

**Temporary Workspace**: Audio extraction WAVs and whisper output reside in `os.tmpdir()/local-player-workspace` ("auto" mode, customizable in AI Settings) — not in the app directory, protecting flash drives from heavy temporary writes. Requires at least `300 MB` free disk space. Small persistent artifacts (raw/processed JSON) reside in `data/subtitles/`.

---

## Priority Queue (P0–P3)

Priorities: `DEMAND=0`, `NEXT=1`, `FIRST=2`, `BG=3` (lower number wins):
- **P0**: Immediate demand (lesson currently active in player).
- **P1**: Next likely lesson (frontend queues lesson N+1 when lesson N has ready subtitles).
- **P2**: First lesson of each course after scan/rescan (`maybePregenFirstLessons`).
- **P3**: Background generation (`maybePregenBackground`, batch of 20, runs only when no P0/P1/P2 jobs are queued).

The library is **never** queued entirely at once — generation is strictly demand-driven.

---

## Preemption

P0/P1 jobs can immediately free slots by preempting cheap-to-restart jobs: `extracting` (fast) or `transcribing` within `PREEMPT_GRACE_MS` (20s, model just loaded). Preempted jobs are requeued at **P3** (`PREEMPT_RETRY_PRIORITY`). Immediate playback demand **never waits** behind background tasks.

---

## Job Lifecycle & Resumption

Jobs transition across `queued | extracting | transcribing | processing | formatting`, tracked in `data/subtitles/jobs.json` + memory queue. On server boot:
- With **valid raw artifact** $\rightarrow$ resumes at `processing` (post-processing only, avoiding redundant whisper reruns).
- Without raw artifact $\rightarrow$ resets to `queued`.

---

## Raw-Sourced Gate

The pipeline only reuses raw transcriptions when `raw.source.mtimeMs + size` match the current video file on disk. If a video is modified, old raw artifacts are invalidated, triggering clean re-extraction and re-transcription. Using `force=1` clears cache and raw files, regenerating from scratch.

---

## Storage & Canonical Artifacts

- Subtitle cache key: `sha1(libId\0rel).slice(0, 24)`.
- **Canonical VTT** is saved at `ROOT/<course>/.courseplayer/subtitles/<hash>.vtt` (the `.courseplayer` prefix is hidden and ignored by scans), ensuring subtitles travel with portable drives.
- **Mirror copy** is preserved in `data/subtitles/<hash>.vtt`.
- Route `GET /subtitles/<hash>.vtt?rel=` serves canonical first, falling back to data mirror.

---

## Whisper Invocation

Invoked with a fixed argument array (no shell):
```text
whisper-cli -m <model> -f <16k mono wav> -l pt -oj -otxt -of <prefix> [-t N] [-pp]
```
Progress is parsed from stderr (`progress = N%`) and reflected in `/api/subtitles/status`. If flags are rejected by older builds, the process automatically retries once with a minimal flag set.

---

## Concurrency & Resource Semaphore

FFmpeg transcoding and Whisper transcription share the **same** `heavySlots` semaphore (never run simultaneously by default). Initialized by `MAX_CONCURRENT_AI_JOBS` (default 1) and adjustable at runtime via `refreshHeavyMax`. LLM network requests do not consume heavy slots.

---

## Player UI Integration

- Subtitles render in custom `.subtitle-overlay` positioned to the video's letterboxed geometry (`object-fit: contain`). Native `<track>` is never used.
- Status badge (`.subtitle-status`) indicates progress: `Available`, `Generating...`, `Unavailable`, or `Error`.
- Action button (`.subtitle-action`) triggers P0 generation or forced regeneration.
- Subtitle generation **never blocks** `video.play()`.

---

## Subtitle Subsystem API Routes

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/subtitles/status?path=<rel>` | GET | Video subtitle status (`ready`, `status`, `percent`) |
| `/api/subtitles/list` | GET | List ready subtitles and active queue jobs |
| `/api/subtitles/generate` | POST | Queue subtitle generation (`priority=0-3`, `force=1`, `skipIfReady=1`) |
| `/api/subtitles/generate-course` | POST | Queue course videos without subtitles at P3 |
| `/api/subtitles/cancel` | POST | Cancel job by hash |
| `/api/subtitles/clear` | POST | Clear jobs and subtitle cache (`requireAdminOrLocal`) |
| `/subtitles/<24-hex>.vtt?rel=<path>` | GET | Serve WebVTT content (canonical first, mirror fallback) |

---

## AI Configuration Routes

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/ai/status` | GET | Live status of transcription and LLM providers |
| `/api/ai/config` | GET | Masked configuration (`hasApiKey` boolean, no raw keys) |
| `/api/ai/config` | POST | Save partial configuration patch (`requireAdminOrLocal`) |
| `/api/ai/reset` | POST | Reset AI configuration to default (`requireAdminOrLocal`) |
| `/api/ai/llm/test` | POST | Test connection to configured LLM endpoint (`requireAdminOrLocal`) |
