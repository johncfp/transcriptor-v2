import type { Effort } from "../../shared/providers";
import type { RawResearch } from "../../shared/verify";

export interface ProviderCall {
  apiKey: string;
  model: string;
  /** Overrides the API origin (Qwen's region-specific endpoint; tests). */
  baseUrl?: string;
  /** Only for providers that take one; omitted = the model's own default. */
  effort?: Effort;
  signal?: AbortSignal;
}

export interface WritingProvider {
  /** A provider id from src/shared/providers.ts. */
  id: string;
  label: string;
  defaultModel: string;
  /** Look up the guest with the provider's web search. */
  research(call: ProviderCall, prompt: { system: string; user: string }): Promise<RawResearch>;
  /** Write the draft; returns parsed JSON (checked by coerceDraft/checkDraft afterwards). */
  draft(call: ProviderCall, prompt: { system: string; user: string }): Promise<unknown>;
}

/** An error with a message meant for the person using the app. */
export class ProviderError extends Error {}
