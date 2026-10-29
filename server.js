"use strict";

const http = require("http");
const crypto = require("crypto");

const SERVER_NAME = "pink-mcp";
const SERVER_VERSION = "0.2.0";
const DEFAULT_PROTOCOL = "2025-03-26";
const BODY_LIMIT = 4 * 1024 * 1024;
const TEXT_LIMIT = 1500000;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

const INSTRUCTIONS = [
  "These tools run inside an open PinK window and use that window's project.",
  "If several PinK windows are open, call pink_mcp_list_instances and pink_mcp_use_instance first.",
  "Names containing \"query\" or \"read\" are read-only.",
  "Write and scene tools are hidden unless pinkMcp.exposeWrites is enabled;",
  "even then they still require confirmation inside a PinK Chat request.",
].join(" ");

const VIRTUAL_TOOLS = [
  {
    name: "pink_mcp_list_instances",
    description: "List live PinK windows: project path, port, role, and the current selection. Does not return tokens.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "pink_mcp_use_instance",
    description: "Select the PinK window later pink_* calls should use. Pass instanceId from pink_mcp_list_instances, or projectPath.",
    inputSchema: {
      type: "object",
      properties: {
        instanceId: { type: "string", description: "Instance id from pink_mcp_list_instances" },
        projectPath: { type: "string", description: "Workspace folder to match" },
      },
    },
  },
  {
    name: "pink_mcp_current",
    description: "Show this MCP process and the selected PinK window.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "pink_mcp_execute_command",
    description: "Run an allowlisted PinK/VS Code command in the selected window (open scene, preview, reload window). Not a pink_* Chat write.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, description: "Command id, for example vscode.open or workbench.action.reloadWindow" },
        args: { type: "array", description: "Optional command arguments as a JSON array" },
      },
      required: ["command"],
    },
  },
];

function isReadOnlyName(name) {
  if (name.startsWith("pink_mcp_")) return true;
  return name.includes("_query") || name.includes("_read");
}

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

function normalizeTools(tools, prefix, exposeWrites) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  const seen = new Set();
  for (const tool of tools) {
    const name = tool && typeof tool.name === "string" ? tool.name : "";
    if (!name || seen.has(name) || !TOOL_NAME.test(name)) continue;
    if (prefix && !name.startsWith(prefix)) continue;
    if (!exposeWrites && !isReadOnlyName(name)) continue;
    seen.add(name);
    const description = typeof tool.description === "string" ? tool.description : "";
    const inputSchema = normalizeSchema(tool.inputSchema);
    const entry = { name, description, inputSchema };
    if (isReadOnlyName(name)) entry.annotations = { readOnlyHint: true };
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
  const requireToken = options.requireToken !== false;
  const prefix = typeof options.toolPrefix === "string" ? options.toolPrefix : "pink_";
  const exposeWrites = Boolean(options.exposeWrites);
  const listenMode = options.listenMode === "auto" ? "auto" : "fixed";
  const log = typeof options.log === "function" ? options.log : function () {};
  const instance = options.instance && typeof options.instance === "object" ? options.instance : {};
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
    if (!loopbackHost(req.headers.host)) {
      sendJson(res, 403, rpcError(null, -32001, "Forbidden"));
      return Promise.resolve();
    }
    if (!originAllowed(req.headers.origin)) {
      log("rejected origin " + req.headers.origin);
      sendJson(res, 403, rpcError(null, -32001, "Forbidden"));
      return Promise.resolve();
    }
    if (url.pathname === "/health" || url.pathname === "/health/") {
      if (req.method !== "GET") {
        res.writeHead(405, { Allow: "GET", "Content-Length": "0" });
        res.end();
        return Promise.resolve();
      }
      if (!authorized(token, req.headers.authorization, requireToken)) {
        sendJson(res, 401, { ok: false, error: "Unauthorized" });
        return Promise.resolve();
      }
      sendJson(res, 200, healthPayload());
      return Promise.resolve();
    }
    if (url.pathname !== "/mcp" && url.pathname !== "/mcp/") {
      sendJson(res, 404, rpcError(null, -32601, "Not found"));
      return Promise.resolve();
    }
    if (!authorized(token, req.headers.authorization, requireToken)) {
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

  function healthPayload() {
    return {
      ok: true,
      name: SERVER_NAME,
      version: SERVER_VERSION,
      instance: publicIdentity(),
    };
  }

  function publicIdentity() {
    return {
      id: instance.id || "",
      pid: instance.pid || process.pid,
      port: boundPort(),
      projectPath: instance.projectPath || "",
      projectName: instance.projectName || "",
      folders: Array.isArray(instance.folders) ? instance.folders : [],
      role: instance.role || "instance",
    };
  }

  function boundPort() {
    const address = server.address();
    return address && typeof address === "object" ? address.port : port;
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
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION, instance: publicIdentity() },
        instructions: INSTRUCTIONS,
      };
    }
    if (method === "ping") return {};
    if (method === "tools/list") {
      if (typeof params.cursor === "string" && params.cursor) return { tools: [] };
      return Promise.resolve(listedTools()).then((tools) => ({ tools }));
    }
    if (method === "tools/call") return call(params, signal);
    const error = new Error("Method not found: " + method);
    error.code = -32601;
    throw error;
  }

  function listedTools() {
    return Promise.resolve(options.listTools()).then((tools) => {
      return VIRTUAL_TOOLS.concat(normalizeTools(tools, prefix, exposeWrites));
    });
  }

  function call(params, signal) {
    const name = params && typeof params.name === "string" ? params.name : "";
    const args = params && params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
    if (name.startsWith("pink_mcp_")) return callVirtual(name, args);
    return listedTools().then((tools) => {
      const known = tools.some((tool) => tool.name === name);
      if (!known) {
        if (!exposeWrites && TOOL_NAME.test(name) && name.startsWith(prefix) && !isReadOnlyName(name)) {
          return toolError("Write tool " + name + " is hidden. Enable pinkMcp.exposeWrites in PinK to expose it.");
        }
        return toolError("Unknown tool: " + name);
      }
      if (signal.aborted) return toolError("Cancelled");
      return Promise.resolve(routeCall(name, args, signal)).then(
        (text) => ({ content: [{ type: "text", text: typeof text === "string" ? text : "" }], isError: false }),
        (error) => toolError(error && error.message ? error.message : String(error))
      );
    });
  }

  function callVirtual(name, args) {
    if (name === "pink_mcp_list_instances") {
      return Promise.resolve(options.listInstances ? options.listInstances() : []).then((rows) => {
        const instances = Array.isArray(rows) ? rows : [];
        const selected = options.currentSelection ? options.currentSelection() : null;
        return okJson({ selected, instances, self: publicIdentity() });
      });
    }
    if (name === "pink_mcp_use_instance") {
      if (typeof options.useInstance !== "function") return toolError("This process cannot change the selected PinK window.");
      return Promise.resolve(options.useInstance(args || {})).then(
        (selected) => {
          if (!selected) return toolError("No live PinK window matched that instanceId or projectPath.");
          return okJson({ selected, self: publicIdentity() });
        },
        (error) => toolError(error && error.message ? error.message : String(error))
      );
    }
    if (name === "pink_mcp_current") {
      const selected = options.currentSelection ? options.currentSelection() : publicIdentity();
      return Promise.resolve(okJson({ self: publicIdentity(), selected }));
    }
    if (name === "pink_mcp_execute_command") {
      if (typeof options.executeCommand !== "function") {
        return toolError("This process cannot run editor commands.");
      }
      return Promise.resolve(options.executeCommand(args || {})).then(
        (result) => okJson(result && typeof result === "object" ? result : { ok: true, result }),
        (error) => toolError(error && error.message ? error.message : String(error))
      );
    }
    return Promise.resolve(toolError("Unknown tool: " + name));
  }

  function routeCall(name, args, signal) {
    try {
      if (typeof options.resolveTarget !== "function") {
        return options.callTool(name, args, signal);
      }
      const target = options.resolveTarget();
      if (!target) {
        return Promise.reject(new Error("Multiple PinK windows are open. Call pink_mcp_list_instances, then pink_mcp_use_instance."));
      }
      if (target.local || target.port === boundPort()) {
        return options.callTool(name, args, signal);
      }
      if (typeof options.proxyTool !== "function") {
        return Promise.reject(new Error("Selected PinK window is on port " + target.port + " and this process cannot proxy to it."));
      }
      return options.proxyTool(target, name, args, signal);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function cancelInflight(params) {
    const requestId = params && params.requestId;
    if (requestId === undefined || requestId === null) return;
    const pending = inflight.get(JSON.stringify(requestId));
    if (pending) pending.abort();
  }

  return listenHttp(server, port, listenMode).then((bound) => {
    const url = "http://127.0.0.1:" + bound + "/mcp";
    log("listening " + url);
    return {
      port: bound,
      url,
      instance: publicIdentity(),
      close() {
        return new Promise((done) => server.close(() => done()));
      },
    };
  });
}

function listenHttp(server, port, listenMode) {
  function attempt(next) {
    return new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(next, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        resolve(address && typeof address === "object" ? address.port : next);
      });
    });
  }
  if (listenMode !== "auto") return attempt(port);
  let current = port;
  const start = async function () {
    for (let i = 0; i < 32; i++) {
      try {
        return await attempt(current);
      } catch (error) {
        if (!error || error.code !== "EADDRINUSE") throw error;
        current += 1;
      }
    }
    return attempt(0);
  };
  return start();
}

function okJson(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: false };
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

function authorized(expected, header, requireToken) {
  if (!expected) return requireToken === false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header || "");
  if (!match) return false;
  const left = crypto.createHash("sha256").update(expected).digest();
  const right = crypto.createHash("sha256").update(match[1]).digest();
  return crypto.timingSafeEqual(left, right);
}

function mcpPost(port, token, message, signal) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(message);
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Host: "127.0.0.1:" + port,
        Authorization: "Bearer " + token,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: res.statusCode, json: raw ? JSON.parse(raw) : null });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    if (signal) {
      const onAbort = () => req.destroy(Object.assign(new Error("Cancelled"), { code: "ABORT_ERR" }));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    req.write(body);
    req.end();
  });
}

async function proxyTool(target, name, args, token, signal) {
  const response = await mcpPost(target.port, token, {
    jsonrpc: "2.0",
    id: "proxy-" + Date.now(),
    method: "tools/call",
    params: { name, arguments: args },
  }, signal);
  const result = response.json && response.json.result;
  if (!result) throw new Error("Proxy call failed with HTTP " + response.status);
  if (result.isError) throw new Error(result.content && result.content[0] ? result.content[0].text : "Proxy tool error");
  return result.content && result.content[0] ? result.content[0].text : "";
}

module.exports = {
  SERVER_VERSION,
  textFromToolResult,
  normalizeTools,
  isReadOnlyName,
  startMcpServer,
  mcpPost,
  proxyTool,
};
