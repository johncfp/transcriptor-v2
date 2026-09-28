import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for the Claude Messages API, used by the unit tests and
 * the smoke test to run the real SDK code paths without a key or network.
 * Non-streaming requests get a guest-research reply (a web search result
 * plus a record_guest_research tool call); streaming requests get `draft`
 * back as the JSON text of the reply.
 */
export interface FakeAnthropicOptions {
  draft: unknown;
  research?: {
    searched: string[];
    input: { identified: boolean; facts: { fact: string; source_urls: string[] }[]; links: { label: string; url: string }[] };
  };
  /** Respond with this HTTP status instead (e.g. 401). */
  status?: number;
}

export interface FakeAnthropic {
  url: string;
  requests: { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[];
  close: () => void;
}

function sse(res: http.ServerResponse, text: string): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: {
      id: "msg_fake_draft",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 1 },
    },
  });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  // Split into a few deltas, as a real stream would.
  const size = Math.ceil(text.length / 3);
  for (let i = 0; i < text.length; i += size) {
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + size) } });
  }
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 50 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

export function startFakeAnthropic(opts: FakeAnthropicOptions): Promise<FakeAnthropic> {
  const requests: FakeAnthropic["requests"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      if (opts.status) {
        res.writeHead(opts.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
        return;
      }
      if (body.stream) return sse(res, JSON.stringify(opts.draft));

      const research = opts.research ?? { searched: [], input: { identified: false, facts: [], links: [] } };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_fake_research",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [
            { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "guest" } },
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu_1",
              content: research.searched.map((url) => ({
                type: "web_search_result",
                url,
                title: url,
                encrypted_content: "x",
                page_age: null,
              })),
            },
            { type: "tool_use", id: "toolu_1", name: "record_guest_research", input: research.input },
          ],
        }),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => server.close() });
    }),
  );
}
