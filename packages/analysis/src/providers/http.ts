/** Errors from AI providers. Messages never include request headers or API keys. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly provider: string,
  ) {
    super(message);
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function postJson(
  fetchImpl: FetchLike,
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new ProviderError(`${provider} request failed: ${(err as Error).name === "AbortError" ? "timeout" : (err as Error).message}`, null, true, provider);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string; type?: string } };
      detail = j.error?.message ?? detail;
    } catch {
      /* keep raw snippet */
    }
    const retryable = res.status === 429 || res.status >= 500;
    throw new ProviderError(`${provider} returned ${res.status}: ${detail}`, res.status, retryable, provider);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`${provider} returned non-JSON`, res.status, false, provider);
  }
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export function estimateCostUsd(usage: TokenUsage, inputPerMTok: number | null, outputPerMTok: number | null): number | null {
  if (inputPerMTok === null || outputPerMTok === null) return null;
  return (usage.inputTokens * inputPerMTok + usage.outputTokens * outputPerMTok) / 1_000_000;
}
