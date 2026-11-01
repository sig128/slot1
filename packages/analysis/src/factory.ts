import type { MediaTools } from "./media";
import { TesseractOcr, type OcrEngine } from "./ocr";
import { AnthropicQaProvider, OpenAIQaProvider, type QaProvider } from "./providers/qa";
import { OpenAICompatibleTranscription, type TranscriptionProvider } from "./providers/transcription";
import { AnthropicVisionProvider, OpenAIVisionProvider, type VisionProvider } from "./providers/vision";

/** Subset of environment configuration needed to build providers. */
export interface ProviderEnv {
  VISION_PROVIDER: "none" | "anthropic" | "openai";
  ANTHROPIC_API_KEY: string | null;
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_VISION_MODEL: string | null;
  ANTHROPIC_TEXT_MODEL: string | null;
  OPENAI_API_KEY: string | null;
  OPENAI_BASE_URL: string;
  OPENAI_VISION_MODEL: string | null;
  OPENAI_TEXT_MODEL: string | null;
  TRANSCRIPTION_PROVIDER: "none" | "openai_compatible";
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
  return null;
}

export function createQaProvider(env: ProviderEnv): QaProvider | null {
  if (env.VISION_PROVIDER === "anthropic" && env.ANTHROPIC_API_KEY) {
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
  return null;
}

export function createOcrEngine(available: boolean, env: ProviderEnv, tools: MediaTools): OcrEngine | null {
  return available ? new TesseractOcr(env.TESSERACT_PATH, tools) : null;
}
