import type { MediaTools } from "./media";
import { TesseractOcr, type OcrEngine } from "./ocr";
import { AnthropicQaProvider, OpenAIQaProvider, type QaProvider } from "./providers/qa";
import { ElevenLabsTranscription, OpenAICompatibleTranscription, type TranscriptionProvider } from "./providers/transcription";
import { AnthropicVisionProvider, NvidiaVisionProvider, OpenAIVisionProvider, type VisionProvider } from "./providers/vision";

/** Subset of environment configuration needed to build providers. */
export interface ProviderEnv {
  VISION_PROVIDER: "none" | "anthropic" | "openai" | "nvidia";
  ANTHROPIC_API_KEY: string | null;
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_VISION_MODEL: string | null;
  ANTHROPIC_TEXT_MODEL: string | null;
  OPENAI_API_KEY: string | null;
  OPENAI_BASE_URL: string;
  OPENAI_VISION_MODEL: string | null;
  OPENAI_TEXT_MODEL: string | null;
  NVIDIA_API_KEY: string | null;
  NVIDIA_BASE_URL: string;
  NVIDIA_VISION_MODEL: string;
  TRANSCRIPTION_PROVIDER: "none" | "openai_compatible" | "elevenlabs";
  TRANSCRIPTION_BASE_URL: string;
  TRANSCRIPTION_API_KEY: string | null;
  TRANSCRIPTION_MODEL: string | null;
  TESSERACT_PATH: string;
}

/** Returns null when not configured — callers must report "AI not configured", not fake output. */
export function createVisionProvider(env: ProviderEnv): VisionProvider | null {
  if (env.VISION_PROVIDER === "anthropic" && env.ANTHROPIC_API_KEY && env.ANTHROPIC_VISION_MODEL) {
    return new AnthropicVisionProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_VISION_MODEL, env.ANTHROPIC_BASE_URL);
  }
  if (env.VISION_PROVIDER === "openai" && env.OPENAI_API_KEY && env.OPENAI_VISION_MODEL) {
    return new OpenAIVisionProvider(env.OPENAI_API_KEY, env.OPENAI_VISION_MODEL, env.OPENAI_BASE_URL);
  }
  if (env.VISION_PROVIDER === "nvidia" && env.NVIDIA_VISION_MODEL) {
    return new NvidiaVisionProvider(env.NVIDIA_API_KEY, env.NVIDIA_VISION_MODEL, env.NVIDIA_BASE_URL);
  }
  return null;
}

export function createQaProvider(env: ProviderEnv): QaProvider | null {
  // Cosmos describes video; questions in words stay with Claude when its key is there.
  if ((env.VISION_PROVIDER === "anthropic" || env.VISION_PROVIDER === "nvidia") && env.ANTHROPIC_API_KEY) {
    const model = env.ANTHROPIC_TEXT_MODEL ?? env.ANTHROPIC_VISION_MODEL;
    if (model) return new AnthropicQaProvider(env.ANTHROPIC_API_KEY, model, env.ANTHROPIC_BASE_URL);
  }
  if (env.VISION_PROVIDER === "openai" && env.OPENAI_API_KEY) {
    const model = env.OPENAI_TEXT_MODEL ?? env.OPENAI_VISION_MODEL;
    if (model) return new OpenAIQaProvider(env.OPENAI_API_KEY, model, env.OPENAI_BASE_URL);
  }
  return null;
}

export function createTranscriptionProvider(env: ProviderEnv): TranscriptionProvider | null {
  if (env.TRANSCRIPTION_PROVIDER === "openai_compatible" && env.TRANSCRIPTION_MODEL) {
    return new OpenAICompatibleTranscription(env.TRANSCRIPTION_BASE_URL, env.TRANSCRIPTION_API_KEY, env.TRANSCRIPTION_MODEL);
  }
  if (env.TRANSCRIPTION_PROVIDER === "elevenlabs" && env.TRANSCRIPTION_API_KEY) {
    // The OpenAI default base URL means "not set" here: ElevenLabs has its own.
    const base = /api\.openai\.com/.test(env.TRANSCRIPTION_BASE_URL) ? "https://api.elevenlabs.io" : env.TRANSCRIPTION_BASE_URL;
    return new ElevenLabsTranscription(base, env.TRANSCRIPTION_API_KEY, env.TRANSCRIPTION_MODEL ?? "scribe_v2");
  }
  return null;
}

export function createOcrEngine(available: boolean, env: ProviderEnv, tools: MediaTools): OcrEngine | null {
  return available ? new TesseractOcr(env.TESSERACT_PATH, tools) : null;
}
