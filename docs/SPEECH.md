# Live speech transcripts

What's said on a live stream, in whatever language it's said, logged next to what SLOT1 sees.

## Who switches what on

| Who | Where | What it does |
| --- | --- | --- |
| The operator | Admin → Settings → Speech to text | Chooses the speech-to-text service and saves its key (`TRANSCRIPTION_PROVIDER`, `TRANSCRIPTION_BASE_URL`, `TRANSCRIPTION_MODEL`, `TRANSCRIPTION_API_KEY`) |
| Each creator | Studio → Speech: "Transcribe what's said on stream" (`speech_transcripts`, off by default) | Their live streams are transcribed while analysis is on |

Nothing is transcribed for a creator who hasn't switched it on, and the demo is never transcribed. Switching it on or off applies within seconds (the reader restarts).

## Services

Every service detects the language by itself; SLOT1 never asks for a language.

| Admin choice | Provider | Address | Model | Languages |
| --- | --- | --- | --- | --- |
| Groq | `openai_compatible` | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` | Whisper's 99 |
| OpenAI | `openai_compatible` | `https://api.openai.com/v1` | `whisper-1` | Whisper's 99 |
| ElevenLabs | `elevenlabs` | `https://api.elevenlabs.io` | `scribe_v2` | about 90, and tags sounds (laughter, applause) |
| Your own server | `openai_compatible` | any OpenAI-compatible `/audio/transcriptions` (a self-hosted Whisper) | as the server names it | as the model knows |

OpenAI-compatible services are asked for `verbose_json`, which carries the detected language and segment times (a model that refuses it falls back to plain `json`, without the language).

## How it runs

`apps/worker/src/live/speech.ts`, beside the frame analysis of a live session:

1. A second ffmpeg reads the same stream from the gateway, audio only, as 16 kHz mono PCM (`LiveSpeechReader` in `packages/analysis/src/speech.ts`). A stream without sound, or an audio problem, never touches the video analysis.
2. The PCM is cut into 12-second chunks. Chunks quieter than −50 dBFS are skipped. When transcription falls behind, the oldest waiting chunk is dropped, so the log stays live.
3. Each chunk goes to the service as a WAV file and is deleted right after. **The audio is never stored.**
4. The text, the detected language, the segments and any tagged sounds are kept as a `transcript` evidence asset (JSON, `b/<b>/s/<s>/src/<source>/speech/<pts>.json`), with the same retention as the session's frames.
5. A `dialogue` entry joins the live log: `Said (Turkish): “Polis geliyor, kaçın!”`, origin `audio`, interpretation `inferred`, the original words in `raw_text`, the transcript as evidence. Tagged sounds become a `reaction` entry ("Heard on stream: laughter").
6. Media times follow the frame timeline: a chunk's start is placed relative to the latest analyzed frame's PTS and arrival time.

Entries go through the same pipeline as everything else (`ObservationPipeline.addCandidate`, serialized with frame handling), so they reach the live log, Ask SLOT1 and highlights like any other reading.

## The Learning page

`GET /api/learning` → `heard`: lines heard on public, non-test streams, and the languages detected (from the entries' descriptions), most lines first.

## Tests

- `tests/unit/speech.test.ts`: loudness, WAV, chunking, language names, entries, the ElevenLabs and Whisper clients, the Admin presets.
- `tests/integration/live-speech.test.ts`: a real stream with sound through nginx-rtmp and the worker to a mock Whisper; nothing is sent before the creator opts in; the line, its language and its transcript evidence land in the database; no audio is kept.
