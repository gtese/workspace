#!/usr/bin/env node
// 把 Anthropic Messages 的流式请求转成 Open WebUI 的非流式 /api/v1/messages 调用，
// 再合成 Anthropic SSE 事件返回给 dsh。用于绕过 Open WebUI 流式转换返回空内容的问题。
//
// 用法: node dsh-owui-shim.mjs [port-file]
//   env: DSH_SHIM_UPSTREAM   Open WebUI API 根地址（默认 https://chat.tri.local/api）
//        DSH_SHIM_DEBUG=1    打印调试日志到 stderr（不含密钥）
import http from "node:http";
import fs from "node:fs";

const UPSTREAM = (process.env.DSH_SHIM_UPSTREAM || "https://chat.tri.local/api").replace(/\/+$/, "");
const DEBUG = process.env.DSH_SHIM_DEBUG === "1";
const PORT_FILE = process.argv[2] || process.env.DSH_SHIM_PORT_FILE || "";

function log(...args) {
  if (DEBUG) console.error("[dsh-shim]", ...args);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/healthz")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid JSON body" } }));
      return;
    }

    const apiKey = req.headers["x-api-key"] || String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const wantStream = body.stream === true;
    const upstreamBody = { ...body, stream: false };
    delete upstreamBody.stream_options;

    log(
      "request",
      "model=" + body.model,
      "stream=" + wantStream,
      "tools=" + (Array.isArray(body.tools) ? body.tools.length : 0),
      "system=" + (Array.isArray(body.system) ? "array" : typeof body.system),
      "keys=" + Object.keys(body).join(",")
    );

    let upstream;
    try {
      upstream = await fetch(UPSTREAM + "/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": req.headers["anthropic-version"] || "2023-06-01"
        },
        body: JSON.stringify(upstreamBody)
      });
    } catch (error) {
      log("upstream fetch failed:", String(error));
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "api_error", message: String(error) } }));
      return;
    }

    const text = await upstream.text();
    if (!upstream.ok) {
      log("upstream status", upstream.status, "body", text.slice(0, 600));
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(text);
      return;
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      log("upstream returned non-JSON", text.slice(0, 300));
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "api_error", message: "upstream returned non-JSON" } }));
      return;
    }

    const blocks = Array.isArray(message.content) ? message.content : [];
    log("response blocks=" + blocks.map((b) => b.type).join(","), "stop=" + message.stop_reason);

    if (!wantStream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(message));
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    const send = (type, payload) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const usage = message.usage || {};
    const startUsage = {
      input_tokens: numberOr(usage.input_tokens, 0),
      output_tokens: 0
    };
    if (usage.cache_read_input_tokens != null) startUsage.cache_read_input_tokens = numberOr(usage.cache_read_input_tokens, 0);
    if (usage.cache_creation_input_tokens != null) startUsage.cache_creation_input_tokens = numberOr(usage.cache_creation_input_tokens, 0);

    send("message_start", {
      type: "message_start",
      message: {
        id: message.id || "msg_shim",
        type: "message",
        role: "assistant",
        model: message.model || body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: startUsage
      }
    });

    blocks.forEach((block, index) => {
      if (block.type === "text") {
        send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
        if (block.text) {
          send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
        }
        send("content_block_stop", { type: "content_block_stop", index });
      } else if (block.type === "tool_use") {
        send("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} }
        });
        const args = JSON.stringify(block.input ?? {});
        if (args !== "{}") {
          send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: args } });
        }
        send("content_block_stop", { type: "content_block_stop", index });
      } else if (block.type === "thinking") {
        send("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } });
        if (block.thinking) {
          send("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
        }
        send("content_block_stop", { type: "content_block_stop", index });
      }
    });

    send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason || "end_turn", stop_sequence: null },
      usage: { output_tokens: numberOr(usage.output_tokens, 0) }
    });
    send("message_stop", { type: "message_stop" });
    res.end();
  } catch (error) {
    log("unhandled error", String(error));
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "api_error", message: String(error) } }));
    } else {
      res.end();
    }
  }
});

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  if (PORT_FILE) {
    try {
      fs.writeFileSync(PORT_FILE, String(port), { mode: 0o600 });
    } catch (error) {
      console.error("[dsh-shim] cannot write port file:", String(error));
    }
  }
  console.log(`LISTEN=${port}`);
});
