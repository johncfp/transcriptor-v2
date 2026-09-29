// GPT (OpenAI Responses API), Kimi and Qwen (OpenAI-compatible chat
// completions). Called with fetch: none of these are Anthropic, and each
// needs a slightly different request.
//
// Only GPT returns the pages its web search used, so only GPT's guest facts
// and links can be confirmed. Kimi and Qwen search too, but their sources
// never reach us, so their findings are kept as unconfirmed.

import { providerById } from "../../shared/providers";
import type { RawResearch } from "../../shared/verify";
import { AbortedError } from "../transcribe/multipart";
import { JSON_INSTRUCTION, RESEARCH_TOOL, WRITING_SCHEMA } from "./prompts";
import { ProviderError, type ProviderCall, type WritingProvider } from "./types";

const RESEARCH_JSON_INSTRUCTION = `When you're done searching, reply with a single JSON object and nothing else, matching this JSON schema:\n${JSON.stringify(RESEARCH_TOOL.input_schema)}`;

type Json = Record<string, unknown>;

async function post(label: string, url: string, apiKey: string, body: unknown, signal?: AbortSignal): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new AbortedError("aborted");
    throw new ProviderError(`Couldn't reach ${label}. Check your internet connection and try again.`);
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new ProviderError(`${label} rejected the API key. Check it in Settings.`);
  if (res.status === 429) throw new ProviderError(`${label} is rate-limiting requests or the account is out of credit. Try again later.`);
  if (!res.ok) {
    let detail = "";
    try {
      const e = (JSON.parse(text) as Json).error as Json | undefined;
      detail = typeof e?.message === "string" ? e.message : "";
    } catch {
      // not JSON
    }
    throw new ProviderError(`${label} returned an error (${res.status})${detail ? `: ${detail}` : "."}`);
  }
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new ProviderError(`${label} sent back a response that couldn't be read.`);
  }
}

/** Parse JSON from model text, tolerating ```json fences or a sentence around it. */
export function parseLooseJson(text: string, label: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  try {
    return JSON.parse(start >= 0 && end > start ? fenced.slice(start, end + 1) : fenced);
  } catch {
    throw new ProviderError(`${label}'s reply couldn't be read. Try again.`);
  }
}

const trimSlash = (s: string) => s.replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// GPT: Responses API

/** Text and cited URLs from a Responses API result. */
export function readResponses(data: Json): { text: string; urls: string[] } {
  let text = "";
  const urls: string[] = [];
  for (const item of (data.output as Json[] | undefined) ?? []) {
    if (item.type === "web_search_call") {
      const sources = ((item.action as Json | undefined)?.sources as Json[] | undefined) ?? [];
      for (const s of sources) if (typeof s.url === "string") urls.push(s.url);
    }
    if (item.type === "message") {
      for (const part of (item.content as Json[] | undefined) ?? []) {
        if (part.type === "output_text" && typeof part.text === "string") text += part.text;
        for (const a of (part.annotations as Json[] | undefined) ?? []) {
          if (a.type === "url_citation" && typeof a.url === "string") urls.push(a.url);
        }
      }
    }
  }
  return { text, urls };
}

export const openaiWriter: WritingProvider = {
  id: "openai",
  label: "GPT",
  defaultModel: providerById("openai")!.defaultModel!,

  async research(call, prompt) {
    const data = await post(
      "GPT",
      `${trimSlash(call.baseUrl ?? "https://api.openai.com/v1")}/responses`,
      call.apiKey,
      {
        model: call.model,
        instructions: prompt.system,
        input: prompt.user,
        tools: [{ type: "web_search" }],
        include: ["web_search_call.action.sources"],
        ...(call.effort ? { reasoning: { effort: call.effort } } : {}),
        text: { format: { type: "json_schema", name: "guest_research", schema: RESEARCH_TOOL.input_schema, strict: true } },
      },
      call.signal,
    );
    const { text, urls } = readResponses(data);
    const parsed = parseLooseJson(text, "GPT") as Omit<RawResearch, "searchedUrls">;
    return { ...parsed, searchedUrls: urls };
  },

  async draft(call, prompt) {
    const data = await post(
      "GPT",
      `${trimSlash(call.baseUrl ?? "https://api.openai.com/v1")}/responses`,
      call.apiKey,
      {
        model: call.model,
        instructions: prompt.system,
        input: prompt.user,
        text: { format: { type: "json_schema", name: "show_notes", schema: WRITING_SCHEMA, strict: true } },
        ...(call.effort ? { reasoning: { effort: call.effort } } : {}),
      },
      call.signal,
    );
    return parseLooseJson(readResponses(data).text, "GPT");
  },
};

// ---------------------------------------------------------------------------
// Kimi and Qwen: chat completions

interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

async function chat(label: string, call: ProviderCall, baseUrl: string, body: Json): Promise<{ message: ChatMessage; finish: string }> {
  const data = await post(label, `${trimSlash(call.baseUrl ?? baseUrl)}/chat/completions`, call.apiKey, body, call.signal);
  const choice = ((data.choices as Json[] | undefined) ?? [])[0];
  if (!choice) throw new ProviderError(`${label} sent back an empty response.`);
  return { message: choice.message as ChatMessage, finish: String(choice.finish_reason ?? "") };
}

const KIMI_BASE = "https://api.moonshot.ai/v1";

export const kimiWriter: WritingProvider = {
  id: "moonshot",
  label: "Kimi",
  defaultModel: providerById("moonshot")!.defaultModel!,

  async research(call, prompt) {
    const messages: ChatMessage[] = [
      { role: "system", content: `${prompt.system}\n\n${RESEARCH_JSON_INSTRUCTION}` },
      { role: "user", content: prompt.user },
    ];
    // Kimi's built-in search: the model asks for $web_search, we hand its
    // arguments straight back, and Kimi runs the search itself.
    for (let round = 0; round < 6; round++) {
      const { message, finish } = await chat("Kimi", call, KIMI_BASE, {
        model: call.model,
        messages,
        tools: [{ type: "builtin_function", function: { name: "$web_search" } }],
      });
      if (finish !== "tool_calls" || !message.tool_calls?.length) {
        const parsed = parseLooseJson(message.content ?? "", "Kimi") as Omit<RawResearch, "searchedUrls">;
        return { ...parsed, searchedUrls: null };
      }
      messages.push(message);
      for (const tc of message.tool_calls) {
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: tc.function.arguments });
      }
    }
    throw new ProviderError("Kimi didn't finish the guest lookup.");
  },

  async draft(call, prompt) {
    const { message } = await chat("Kimi", call, KIMI_BASE, {
      model: call.model,
      messages: [
        { role: "system", content: `${prompt.system}\n\n${JSON_INSTRUCTION}` },
        { role: "user", content: prompt.user },
      ],
      response_format: { type: "json_object" },
    });
    return parseLooseJson(message.content ?? "", "Kimi");
  },
};

export const QWEN_BASE = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

export const qwenWriter: WritingProvider = {
  id: "qwen",
  label: "Qwen",
  defaultModel: providerById("qwen")!.defaultModel!,

  async research(call, prompt) {
    const { message } = await chat("Qwen", call, QWEN_BASE, {
      model: call.model,
      messages: [
        { role: "system", content: `${prompt.system}\n\n${RESEARCH_JSON_INSTRUCTION}` },
        { role: "user", content: prompt.user },
      ],
      enable_search: true,
    });
    const parsed = parseLooseJson(message.content ?? "", "Qwen") as Omit<RawResearch, "searchedUrls">;
    return { ...parsed, searchedUrls: null };
  },

  async draft(call, prompt) {
    const { message } = await chat("Qwen", call, QWEN_BASE, {
      model: call.model,
      messages: [
        { role: "system", content: `${prompt.system}\n\n${JSON_INSTRUCTION}` },
        { role: "user", content: prompt.user },
      ],
      response_format: { type: "json_object" },
    });
    return parseLooseJson(message.content ?? "", "Qwen");
  },
};
