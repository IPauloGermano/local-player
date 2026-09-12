# Local Whisper — Installation and Configuration

**English** | [Português](pt-br/whisper.md)

Self-contained guide to getting **whisper.cpp** working with Local Player (offline local subtitle transcription). Tested on an Ubuntu x86-64 machine with release **whisper.cpp 1.9.2** and the **`ggml-small.bin`** model.

Nothing is downloaded automatically by the project. The server simply **detects** the binary and the model, executing whisper as a local child process (`spawn`, without shell). Without the binary or model, the player continues to function normally — subtitles simply report "unavailable".

---

## 1. Requirements

- **ffmpeg** with `ffmpeg`/`ffprobe` in PATH (or `FFMPEG_BIN`/`FFPROBE_BIN`) — already used for transcoding; ASR audio extraction depends on it.
- A filesystem with **execution permissions** for the binary (Linux/NTFS).
  **FAT/vfat drives (USB flash drives) do not allow binary execution.**
- The GGML model (`ggml-*.bin`) — passive data file, can reside on any filesystem (including FAT/vfat USB drives).

---

## 2. Installing the Binary

1. Download the release for your platform from:
   <https://github.com/ggml-org/whisper.cpp/releases> — for example `whisper-bin-ubuntu-x64.tar.gz` (Linux x86-64).
2. Extract the archive. The package contains `whisper-cli` **and its sibling shared libraries** (`libggml*.so*`). **Keep everything together in the same directory**: the executable loads `libggml-cpu-*.so`/`libggml-base.so`/`libggml.so.0` via its binary rpath. Moving only `whisper-cli` breaks loading.
3. Grant execution permissions: `chmod +x whisper-cli`.

```bash
# Example: extract to ~/.local/opt/whisper.cpp/whisper-bin-ubuntu-x64/
tar -xzf whisper-bin-ubuntu-x64.tar.gz
chmod +x whisper-bin-ubuntu-x64/whisper-cli

# Verify that it loads and displays version:
whisper-bin-ubuntu-x64/whisper-cli --version
# -> whisper.cpp version: 1.9.2
```

If the app (and `bin/`) is located on a vfat USB drive, **do not** copy the binary there — point `WHISPER_BIN` to the ext4 path (see §4).

---

## 3. Installing the Model

Download a GGML model from the official Hugging Face repository (`ggerganov/whisper.cpp`) and place it inside `models/`:

```bash
# ~465 MB — recommended precision/speed ratio
wget https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin \
  -O models/ggml-small.bin

# Smaller alternatives (faster, less accurate):
#   ggml-base.bin  (~142 MB)
#   ggml-tiny.bin  (~75 MB)
```

Expected location: `models/ggml-small.bin` (the server scans `models/` for `ggml-*.bin`). Quantized variants (e.g. `ggml-small-q5_1.bin`) are also recognized.

---

## 4. Pointing the Server to the Binary (Env Vars)

| Variable | Default | Usage |
| --- | --- | --- |
| `WHISPER_BIN` | searches for `whisper-cli*` in `bin/` | full path to binary (supports spaces) |
| `WHISPER_MODEL_DIR` | `models/` (next to `server.js`) | directory containing `ggml-*.bin` models |

```bash
WHISPER_BIN=/path/to/whisper-cli npm start
```

Real example for a vfat USB app installation pointing to an internal ext4 binary:

```bash
WHISPER_BIN="$HOME/.local/opt/whisper.cpp/whisper-bin-ubuntu-x64/whisper-cli" \
PORT=4173 node server.js
```

---

## 5. Validating the Installation

```bash
# 1. Live status — verifies detected binary and model:
curl http://localhost:4173/api/ai/status
#    whisper: available=true, installedModel=small, models[small].installed=true

# 2. Current config (masked, no raw API keys):
curl http://localhost:4173/api/ai/config

# 3. Generate subtitle for a video on demand (priority 0 = active lesson):
curl -X POST "http://localhost:4173/api/subtitles/generate?priority=0&path=<video-rel-path>"

# 4. Once complete, canonical VTT is located at:
#    ROOT/<course>/.courseplayer/subtitles/<hash>.vtt
#    and the data mirror at data/subtitles/<hash>.vtt
```

The server console will display:
`extracting audio → transcribing → postprocessing → formatting VTT → complete`.

---

## 6. How the Pipeline Invokes Whisper

Fixed argument array (no shell), constructed by `server.js`:

```text
whisper-cli -m <model> -f <16k mono wav> -l pt -oj -otxt -of <prefix>
             [-t N]      # if advanced.transcriptionThreads > 0
             [-pp]       # real progress (stderr `progress = N%`)
```

- Audio is extracted using FFmpeg to **16 kHz mono PCM16 WAV** before transcription.
- Language (`-l pt`) originates from `transcription.language` config.
- If the binary rejects an optional flag (older build), the pipeline catches the stderr error and **retries once** with minimal arguments — transcription never fails due to optional flags.

### Note on VAD (Voice Activity Detection)

**whisper-cli 1.9.2 rejects the `-vad` short flag** (exits with code 0 without output), and real VAD requires `-vm`/`--vad-model` with `ggml-silero-vad.bin` (not installed by default). Therefore:
- The pipeline omits `-vad`, and the AI Center accurately reports VAD as unsupported.
- Normal transcription works smoothly without VAD.

---

## 7. Measured Benchmark Reference

| Item | Value |
| --- | --- |
| Model | `ggml-small.bin` (~465 MB) |
| Machine | Ubuntu x86-64 (Modern CPU, 4 threads) |
| Audio Sample | 159.85 s speech |
| Processing Time | 60.4 s |
| **Real-Time Factor (RTF)** | **≈0.38** (processing time ÷ audio duration) |

Smaller models (`base`/`tiny`) transcribe faster with reduced accuracy.

---

## 8. Troubleshooting

| Symptom | Probable Cause | Action |
| --- | --- | --- |
| Status shows `available:false` | Binary missing in `bin/` or invalid `WHISPER_BIN` | Check §2/§4; ensure `chmod +x` |
| `modelInstalled:false` | Model missing in `models/` (or `WHISPER_MODEL_DIR`) | Check §3 |
| `whisper_model_load: invalid model data (bad magic)` | Corrupted/0-byte model file (interrupted download) | Delete file in `models/` and redownload; verify size (~465 MB for `small`) |
| `cannot start Whisper` | No execution permission (vfat) or missing sibling `.so` files | Move entire folder to ext4; point `WHISPER_BIN` |
| `Whisper did not generate JSON output (unknown argument)` | Build does not support flag | Pipeline auto-retries with minimal args; verify version 1.9.x |
| Inaccurate transcription or wrong language | Incorrect `transcription.language` | Adjust language in AI Settings |

---

## 9. Quick Reference

- Binary: `whisper-cli` (whisper.cpp), official releases at <https://github.com/ggml-org/whisper.cpp/releases>.
- Models: `ggml-*.bin` at <https://huggingface.co/ggerganov/whisper.cpp>.
- Envs: `WHISPER_BIN`, `WHISPER_MODEL_DIR`, `FFMPEG_BIN`, `FFPROBE_BIN`.
- AI Config: `data/ai-config.json` (keys strictly on server).
- Providers: registered in `AI_TRANSCRIPTION_PROVIDERS` in `server/ai/config.js` (data-driven; UI and API contracts remain untouched when adding providers).
