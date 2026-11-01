import pino, { type DestinationStream, type Logger } from "pino";

/**
 * Structured logger with secret redaction. Tokens, cookies, signatures and stream keys are
 * removed before anything is written.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-slot1-csrf"]',
  'req.headers["twitch-eventsub-message-signature"]',
  'res.headers["set-cookie"]',
  "*.access_token",
  "*.refresh_token",
  "*.accessToken",
  "*.refreshToken",
  "*.client_secret",
  "*.clientSecret",
  "*.password",
  "*.pass",
  "*.streamKey",
  "*.stream_key",
  "*.keyEnc",
  "*.key_enc",
  "*.outputUrl",
  "*.publishUrl",
  "*.apiKey",
  "*.api_key",
  "*.secret",
  "*.token",
];

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? "info", destination?: DestinationStream): Logger {
  const options = {
    name,
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return destination ? pino(options, destination) : pino(options);
}

/** Strip anything that looks like a credential from an error message before surfacing it. */
export function sanitizeErrorMessage(message: string): string {
  return message
    // Streaming URLs carry the stream key in their path (rtmp://host/app/KEY): keep only the host.
    .replace(/\b(rtmps?|rtmpt|srt|rtsp):\/\/(?:[^@/\s'"]*@)?([^/\s'"?#]+)[^\s'"]*/gi, "$1://$2/[redacted]")
    .replace(/(authorization|bearer|oauth)\s*[:=]?\s*[a-z0-9._~+/-]{12,}=*/gi, "$1 [redacted]")
    .replace(/(access_token|refresh_token|client_secret|api[_-]?key|token|pass(word)?|key)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/sk-[a-zA-Z0-9_-]{16,}/g, "[redacted]")
    .slice(0, 500);
}

export type { Logger };
