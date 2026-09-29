import Anthropic from "@anthropic-ai/sdk";
import { EFFORTS, providerById, type Effort, type ModelOption } from "../../shared/providers";
import { QWEN_BASE } from "./openai";
import { ProviderError } from "./types";

/**
 * Each writing provider's live model list, so Settings offers new models as
 * they come out instead of a name fixed in the app. Claude's list also says
 * which effort levels each model takes.
 */

type Caps = Record<string, { supported?: boolean; [k: string]: unknown } | undefined>;

const supported = (node: unknown): boolean => (node as { supported?: boolean } | undefined)?.supported === true;

/** The effort levels in a Claude model's capabilities; null if the model list didn't say. */
export function claudeEfforts(caps: Caps | undefined): Effort[] | null {
  const effort = caps?.effort as Record<string, unknown> | undefined;
  if (!effort) return null;
  if (!supported(effort)) return [];
  return EFFORTS.filter((e) => supported(effort[e]));
}

/**
 * Whether the writing step can use a Claude model: it needs adaptive thinking
 * and structured outputs. A model whose capabilities aren't listed is kept.
 */
export function claudeUsable(caps: Caps | undefined): boolean {
  if (!caps) return true;
  const thinking = caps.thinking as { types?: { adaptive?: unknown } } | undefined;
  return supported(thinking?.types?.adaptive) && supported(caps.structured_outputs);
}

async function claudeModels(apiKey: string, baseUrl?: string): Promise<ModelOption[]> {
  const api = new Anthropic({ apiKey, baseURL: baseUrl, maxRetries: 1, timeout: 15_000 });
  const out: ModelOption[] = [];
  try {
    // Newest first; iterating fetches every page.
    for await (const m of api.models.list({ limit: 100 })) {
      const caps = (m as unknown as { capabilities?: Caps }).capabilities;
      if (!claudeUsable(caps)) continue;
      out.push({ id: m.id, label: m.display_name || m.id, efforts: claudeEfforts(caps) });
    }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new ProviderError("Claude rejected the API key. Check it on the API keys tab.");
    }
    if (err instanceof Anthropic.APIConnectionError) throw new ProviderError("Couldn't reach Claude to list its models.");
    if (err instanceof Anthropic.APIError) throw new ProviderError(`Claude returned an error (${err.status}) listing its models.`);
    throw err;
  }
  return out;
}

/** GPT models that write text; the list also has audio, image and embedding models. */
export const isGptWriter = (id: string) =>
  /^(gpt-|o\d)/.test(id) && !/(audio|realtime|tts|transcribe|image|embedding|moderation|search|instruct)/.test(id);

const BASES: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  moonshot: "https://api.moonshot.ai/v1",
  qwen: QWEN_BASE,
};

/** OpenAI-style GET /models (GPT, Kimi, Qwen). */
async function openAiStyleModels(provider: string, apiKey: string, baseUrl?: string): Promise<ModelOption[]> {
  const label = providerById(provider)?.label ?? provider;
  let res: Response;
  try {
    res = await fetch(`${(baseUrl ?? BASES[provider]!).replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ProviderError(`Couldn't reach ${label} to list its models.`);
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError(`${label} rejected the API key. Check it on the API keys tab.`);
  if (!res.ok) throw new ProviderError(`${label} returned an error (${res.status}) listing its models.`);
  const data = ((await res.json().catch(() => ({}))) as { data?: { id?: unknown; created?: unknown }[] }).data ?? [];
  return data
    .filter((m): m is { id: string; created?: unknown } => typeof m.id === "string")
    .filter((m) => provider !== "openai" || isGptWriter(m.id))
    .sort((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0) || a.id.localeCompare(b.id))
    .map((m) => ({ id: m.id, label: m.id, efforts: null }));
}

export function listModels(provider: string, apiKey: string, baseUrl?: string): Promise<ModelOption[]> {
  if (provider === "anthropic") return claudeModels(apiKey, baseUrl);
  if (provider in BASES) return openAiStyleModels(provider, apiKey, baseUrl);
  return Promise.reject(new ProviderError("That provider can't list its models."));
}
