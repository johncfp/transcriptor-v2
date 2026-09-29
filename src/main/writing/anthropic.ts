import Anthropic from "@anthropic-ai/sdk";
import { providerById } from "../../shared/providers";
import type { RawResearch } from "../../shared/verify";
import { AbortedError } from "../transcribe/multipart";
import { RESEARCH_TOOL, WRITING_SCHEMA } from "./prompts";
import { ProviderError, type ProviderCall, type WritingProvider } from "./types";

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;

/**
 * Models that get server-side refusal fallbacks: if the model declines, the
 * API re-runs the same request on a fallback model inside the same call.
 */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1"]);

function client(call: ProviderCall): Anthropic {
  return new Anthropic({ apiKey: call.apiKey, baseURL: call.baseUrl, maxRetries: 2 });
}

function fallbackParams(model: string) {
  return FALLBACK_MODELS.has(model)
    ? { betas: ["server-side-fallback-2026-07-01"] as Anthropic.Beta.AnthropicBeta[], fallbacks: "default" as const }
    : {};
}

/** Map SDK errors to messages for the person using the app. */
function explain(err: unknown): Error {
  if (err instanceof Anthropic.APIUserAbortError) return new AbortedError("aborted");
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError("Claude rejected the API key. Check it in Settings.");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ProviderError("Claude is rate-limiting requests or the account is out of credit. Try again later.");
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new ProviderError("Claude doesn't recognise the model name. Check it in Settings.");
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError("Couldn't reach Claude. Check your internet connection and try again.");
  }
  if (err instanceof Anthropic.APIError) return new ProviderError(`Claude returned an error (${err.status}): ${err.message}`);
  return err instanceof Error ? err : new Error(String(err));
}

function checkStop(message: BetaMessage): void {
  if (message.stop_reason === "refusal") {
    throw new ProviderError("Claude declined to write this episode's notes.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new ProviderError("Claude ran out of room before finishing. Try again, or use a shorter episode.");
  }
}

/** Every URL the web search returned in these responses. */
function searchedUrls(messages: BetaMessage[]): string[] {
  const urls: string[] = [];
  for (const m of messages) {
    for (const block of m.content) {
      // An error result's content is an object; a success is a list of results.
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) urls.push(r.url);
      }
    }
  }
  return urls;
}

export const anthropicWriter: WritingProvider = {
  id: "anthropic",
  label: "Claude",
  defaultModel: providerById("anthropic")!.defaultModel!,

  async research(call, prompt) {
    const api = client(call);
    const messages: BetaMessageParam[] = [{ role: "user", content: prompt.user }];
    const responses: BetaMessage[] = [];
    try {
      // A few rounds at most: the server may pause a long search (pause_turn),
      // or the model may finish without recording, in which case we ask once.
      for (let round = 0; round < 4; round++) {
        const message = await api.beta.messages.create(
          {
            model: call.model,
            max_tokens: 16000,
            thinking: { type: "adaptive" },
            system: prompt.system,
            messages,
            tools: [
              { type: "web_search_20260209", name: "web_search", max_uses: 6 },
              { ...RESEARCH_TOOL, strict: true },
            ],
            ...(call.effort ? { output_config: { effort: call.effort } } : {}),
            ...fallbackParams(call.model),
          },
          { signal: call.signal },
        );
        responses.push(message);
        if (message.stop_reason === "refusal") throw new ProviderError("Claude declined to look up this guest.");

        const recorded = message.content.find((b) => b.type === "tool_use" && b.name === RESEARCH_TOOL.name);
        if (recorded && recorded.type === "tool_use") {
          const input = recorded.input as Omit<RawResearch, "searchedUrls">;
          return { ...input, searchedUrls: searchedUrls(responses) };
        }
        messages.push({ role: "assistant", content: message.content });
        if (message.stop_reason !== "pause_turn") {
          messages.push({ role: "user", content: `Record what you found with the ${RESEARCH_TOOL.name} tool now.` });
        }
      }
    } catch (err) {
      throw explain(err);
    }
    throw new ProviderError("Claude didn't finish the guest lookup.");
  },

  async draft(call, prompt) {
    let message: BetaMessage;
    try {
      // Streamed: a long transcript plus thinking can take a while, and
      // streaming keeps the request clear of HTTP timeouts.
      message = await client(call)
        .beta.messages.stream(
          {
            model: call.model,
            max_tokens: 32000,
            thinking: { type: "adaptive" },
            system: prompt.system,
            messages: [{ role: "user", content: prompt.user }],
            output_config: {
              format: { type: "json_schema", schema: WRITING_SCHEMA },
              ...(call.effort ? { effort: call.effort } : {}),
            },
            ...fallbackParams(call.model),
          },
          { signal: call.signal },
        )
        .finalMessage();
    } catch (err) {
      throw explain(err);
    }
    checkStop(message);
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError("Claude's reply couldn't be read as show notes. Try again.");
    }
  },
};
