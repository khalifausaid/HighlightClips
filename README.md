# HighlightClips

A local-first starter app for finding audio highlight moments in public YouTube videos. Paste a YouTube link; no account sign-in or video/chat ownership check is required. Downloaded videos and optional chat replay files are saved under `data/` on this computer.

## Run it in VS Code

1. Install [Node.js 20 or newer](https://nodejs.org/), [Python 3.10 or newer](https://www.python.org/downloads/) with **Add Python to PATH** selected, [FFmpeg](https://ffmpeg.org/download.html) (including `ffprobe`), and [yt-dlp](https://github.com/yt-dlp/yt-dlp).
2. Open this folder in VS Code.
3. Open **Terminal → New Terminal** and run:

   ```powershell
   pip install -r requirements.txt
   npm start
   ```

4. Open [http://localhost:3000](http://localhost:3000).

No npm package installation is needed; the server uses Node's built-in modules. If a media tool isn't on PATH, set `FFMPEG`, `FFPROBE`, or `YT_DLP` to its executable path before starting the server.

## What works

- Paste a public YouTube video URL and fetch it locally (up to 2 GB).
- Optionally attach a chat replay file (up to 100 MB); no ownership confirmation is required.
- Find up to ten non-overlapping highlight moments using local audio analysis.
- Generate captions only for the selected clip during export. The multilingual faster-whisper model detects the spoken language and supports English translation, English transcription, or transcription in the original language. Choose fast, balanced, or more accurate speech recognition per export.
- Connect an OpenAI, Gemini, or Anthropic API key for AI-assisted translation of the short transcript. The key stays in server memory; only transcript text is sent to the selected provider. Without a connected provider, the local Whisper model can translate speech to English.
- Fit caption line length, font size, placement, and emphasis to the selected aspect ratio and caption style.
- Show estimated remaining time during video fetching, highlight analysis, caption generation, AI connection/translation, and clip rendering.
- Choose 9:16, 4:5, 1:1, or 16:9; fill crop, black fit, or blurred fit layout; 720p through 4K resolution; and high, balanced, or smaller-file encoding quality.
- Delete a project and its source/output files.
- Persist project metadata and media locally in `data/`.

The app accepts public YouTube video links from any user and does not verify ownership. Link fetching is limited to YouTube and youtu.be hosts; private, age-restricted, unavailable, or live videos may fail. This is a single-user local development app, not a hosted multi-user service. The local multilingual Whisper model must be installed with `pip install -r requirements.txt`; model files download on first caption export. Audio is processed locally. When an AI provider is connected for translation, only the selected clip transcript is sent to that provider. Chat replay files are stored but their message contents are not yet included in scoring. Face tracking, animated word-by-word karaoke captions, editing/reordering clips, ZIP exports, sign-in, and retention scheduling are follow-on work.

## Project layout

- `server.js` — local HTTP API, YouTube fetching via yt-dlp, FFmpeg audio analysis and rendering.
- `index.html`, `styles.css`, `app.js` — responsive web interface.
- `data/` — created at runtime; contains uploaded sources, rendered clips, and project records.

## Data handling

This development app binds only to `127.0.0.1`. Do not expose it to a public network. Project files are retained until the user deletes the project or removes the local `data/` folder.
