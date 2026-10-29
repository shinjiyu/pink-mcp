"use strict";

const http = require("http");
const crypto = require("crypto");

const SERVER_NAME = "pink-mcp";
const SERVER_VERSION = "0.1.0";
const DEFAULT_PROTOCOL = "2025-03-26";
const BODY_LIMIT = 4 * 1024 * 1024;
const TEXT_LIMIT = 1500000;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

const INSTRUCTIONS = [
  "These tools run inside the open PinK editor and use its active project.",
  "Names containing \"query\" are read-only.",
  "Write and scene tools still require confirmation inside a PinK Chat request;",
  "calling them here returns that confirmation error.",
].join(" ");

function textFromToolResult(result) {
  const parts = result && Array.isArray(result.content) ? result.content : [];
  const texts = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") {
      if (part != null) texts.push(String(part));
      continue;
    }
    if (typeof part.mimeType === "string" && part.data != null) {
      const bytes = Buffer.from(part.data);
      if (part.mimeType.startsWith("text/") || part.mimeType === "application/json") {
        texts.push(bytes.toString("utf8"));
      } else {
        texts.push("[" + part.mimeType + " " + bytes.length + " bytes]");
      }
      continue;
    }
    if (typeof part.value === "string") {
      texts.push(part.value);
      continue;
    }
    if (part.value !== undefined) texts.push(JSON.stringify(part.value));
  }
  const text = texts.join("\n");
  if (text.length <= TEXT_LIMIT) return text;
  return text.slice(0, TEXT_LIMIT) + "\n…[truncated]";
}

function normalizeTools(tools, prefix) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  const seen = new Set();
  for (const tool of tools) {
    const name = tool && typeof tool.name === "string" ? tool.name : "";
    if (!name || seen.has(name) || !TOOL_NAME.test(name)) continue;
    if (prefix && !name.startsWith(prefix)) continue;
    seen.add(name);
    const description = typeof tool.description === "string" ? tool.description : "";
    const inputSchema = normalizeSchema(tool.inputSchema);
    const entry = { name, description, inputSchema };
    if (name.includes("_query") || name.includes("_read")) {
      entry.annotations = { readOnlyHint: true };
    }
    out.push(entry);
  }
  return out;
}

function normalizeSchema(schema) {
  const base = schema && typeof schema === "object" && !Array.isArray(schema) ? schema : {};
  const properties = {};
  if (base.properties && typeof base.properties === "object" && !Array.isArray(base.properties)) {
    for (const [key, value] of Object.entries(base.properties)) {
      properties[key] = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }
  }
  const out = Object.assign({}, base, { type: "object" });
  if (Object.keys(properties).length > 0 || base.properties) out.properties = properties;
  if (Array.isArray(base.required)) {
    out.required = base.required.filter((key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(properties, key));
  }
  return out;
}

function startMcpServer(options) {
  const port = options.port == null ? 37720 : options.port;
  const token = typeof options.token === "string" ? options.token : "";
  const prefix = typeof options.toolPrefix === "string" ? options.toolPrefix : "pink_";
  const log = typeof options.log === "function" ? options.log : function () {};
  const inflight = new Map();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      log(error && error.message ? error.message : String(error));
      if (!res.headersSent) sendJson(res, 500, rpcError(null, -32603, "Internal error"));
      else res.end();
    });
  });

  function handleRequest(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/mcp" && url.pathname !== "/mcp/") {
      sendJson(res, 404, rpcError(null, -32601, "Not found"));
      return Promise.resolve();
    }
    if (!loopbackHost(req.headers.host)) {
      sendJson(res, 403, rpcError(null, -32001, "Forbidden"));
      return Promise.resolve();
    }
    if (!originAllowed(req.headers.origin)) {
      log("rejected origin " + req.headers.origin);
      sendJson(res, 403, rpcError(null, -32001, "Forbidden"));
      return Promise.resolve();
    }
    if (!authorized(token, req.headers.authorization)) {
      sendJson(res, 403, rpcError(null, -32001, "Forbidden"));
      return Promise.resolve();
    }
    if (req.method === "GET" || req.method === "DELETE" || req.method === "HEAD") {
      res.writeHead(405, { Allow: "POST", "Content-Length": "0" });
      res.end();
      return Promise.resolve();
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST", "Content-Length": "0" });
      res.end();
      return Promise.resolve();
    }
    return readBody(req).then((raw) => dispatchHttp(req, res, raw));
  }

  function dispatchHttp(req, res, raw) {
    let message;
    try {
      message = JSON.parse(raw || "");
    } catch (error) {
      sendJson(res, 400, rpcError(null, -32700, "Parse error"));
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      sendJson(res, 400, rpcError(null, -32600, "Invalid Request"));
      return;
    }
    const method = message.method;
    const id = message.id;
    const isRequest = Object.prototype.hasOwnProperty.call(message, "id") && id !== undefined && id !== null;
    if (typeof method !== "string") {
      sendJson(res, isRequest ? 200 : 400, isRequest ? rpcError(id, -32600, "Invalid Request") : rpcError(null, -32600, "Invalid Request"));
      return;
    }
    if (!isRequest) {
      if (method === "notifications/cancelled") cancelInflight(message.params);
      sendEmpty(res, 202);
      return;
    }
    const ac = new AbortController();
    let finished = false;
    res.on("finish", () => {
      finished = true;
    });
    req.on("close", () => {
      if (!finished) ac.abort();
    });
    const key = JSON.stringify(id);
    inflight.set(key, ac);
    Promise.resolve(dispatch(method, message.params || {}, ac.signal))
      .then((result) => {
        if (res.writableEnded) return;
        sendJson(res, 200, { jsonrpc: "2.0", id, result });
      })
      .catch((error) => {
        if (res.writableEnded) return;
        const code = error && Number.isInteger(error.code) ? error.code : -32603;
        sendJson(res, 200, rpcError(id, code, error && error.message ? error.message : "Internal error"));
      })
      .finally(() => {
        inflight.delete(key);
      });
  }

  function dispatch(method, params, signal) {
    if (method === "initialize") {
      const protocolVersion = typeof params.protocolVersion === "string" && params.protocolVersion ? params.protocolVersion : DEFAULT_PROTOCOL;
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      };
    }
    if (method === "ping") return {};
    if (method === "tools/list") {
      if (typeof params.cursor === "string" && params.cursor) return { tools: [] };
      return Promise.resolve(options.listTools()).then((tools) => ({ tools: normalizeTools(tools, prefix) }));
    }
    if (method === "tools/call") return call(params, signal);
    const error = new Error("Method not found: " + method);
    error.code = -32601;
    throw error;
  }

  function call(params, signal) {
    const name = params && typeof params.name === "string" ? params.name : "";
    const args = params && params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
    return Promise.resolve(options.listTools()).then((listed) => {
      const known = normalizeTools(listed, prefix).some((tool) => tool.name === name);
      if (!known) return toolError("Unknown tool: " + name);
      if (signal.aborted) return toolError("Cancelled");
      return Promise.resolve(options.callTool(name, args, signal)).then(
        (text) => ({ content: [{ type: "text", text: typeof text === "string" ? text : "" }], isError: false }),
        (error) => toolError(error && error.message ? error.message : String(error))
      );
    });
  }

  function cancelInflight(params) {
    const requestId = params && params.requestId;
    if (requestId === undefined || requestId === null) return;
    const pending = inflight.get(JSON.stringify(requestId));
    if (pending) pending.abort();
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      const bound = address && typeof address === "object" ? address.port : port;
      const url = "http://127.0.0.1:" + bound + "/mcp";
      log("listening " + url);
      resolve({
        port: bound,
        url,
        close() {
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(payload.length),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendEmpty(res, status) {
  res.writeHead(status, { "Content-Length": "0" });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error("Body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function loopbackHost(host) {
  if (!host) return false;
  const name = String(host).split(":")[0].replace(/^\[|\]$/g, "").toLowerCase();
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

function originAllowed(origin) {
  if (!origin || origin === "null") return true;
  if (origin.startsWith("vscode-file:") || origin.startsWith("vscode-webview:") || origin.startsWith("file:")) return true;
  try {
    const url = new URL(origin);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  } catch (error) {
    return false;
  }
}

function authorized(expected, header) {
  if (!expected) return true;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header || "");
  if (!match) return false;
  const left = crypto.createHash("sha256").update(expected).digest();
  const right = crypto.createHash("sha256").update(match[1]).digest();
  return crypto.timingSafeEqual(left, right);
}

module.exports = {
  SERVER_VERSION,
  textFromToolResult,
  normalizeTools,
  startMcpServer,
};
