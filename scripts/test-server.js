"use strict";

const assert = require("assert/strict");
const http = require("http");
const test = require("node:test");
const { textFromToolResult, normalizeTools, startMcpServer } = require("../server");

test("textFromToolResult reads text, json bytes, and truncates", () => {
  const text = textFromToolResult({
    content: [
      { value: "hello" },
      { mimeType: "application/json", data: Buffer.from("{\"ok\":1}") },
      { mimeType: "image/png", data: Buffer.from([1, 2, 3]) },
      { value: { scene: 1 } },
    ],
  });
  assert.match(text, /hello/);
  assert.match(text, /"ok":1/);
  assert.match(text, /image\/png 3 bytes/);
  assert.match(text, /"scene":1/);
});

test("normalizeTools keeps pink query tools and object schemas", () => {
  const tools = normalizeTools([
    { name: "pink_assets_query_info", description: "info", inputSchema: { properties: { uuid: { type: "string" } }, required: ["uuid", "missing"] } },
    { name: "copilot_search", description: "no" },
    { name: "pink bad", description: "no" },
    { name: "pink_assets_delete", description: "delete", inputSchema: null },
  ], "pink_");
  assert.deepEqual(tools.map((tool) => tool.name), ["pink_assets_query_info", "pink_assets_delete"]);
  assert.equal(tools[0].inputSchema.type, "object");
  assert.deepEqual(tools[0].inputSchema.required, ["uuid"]);
  assert.equal(tools[0].annotations.readOnlyHint, true);
  assert.equal(tools[1].annotations, undefined);
  assert.equal(tools[1].inputSchema.type, "object");
});

test("streamable HTTP lists and calls tools", async () => {
  const calls = [];
  const server = await startMcpServer({
    port: 0,
    token: "secret",
    toolPrefix: "pink_",
    listTools: () => [
      { name: "pink_system_query", description: "system", inputSchema: { type: "object", properties: {} } },
    ],
    callTool: (name, args, signal) => {
      calls.push({ name, args, aborted: signal.aborted });
      return Promise.resolve("{\"version\":\"0.0.2\"}");
    },
  });
  try {
    const denied = await post(server.port, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { token: "nope" });
    assert.equal(denied.status, 403);

    const foreign = await post(server.port, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { host: "evil.example" });
    assert.equal(foreign.status, 403);

    const init = await post(server.port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    assert.equal(init.status, 200);
    assert.equal(init.json.result.protocolVersion, "2025-03-26");
    assert.equal(init.json.result.serverInfo.name, "pink-mcp");
    assert.equal(init.headers["mcp-session-id"], undefined);

    const note = await post(server.port, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(note.status, 202);
    assert.equal(note.raw, "");

    const get = await request(server.port, "GET", "/mcp");
    assert.equal(get.status, 405);

    const listed = await post(server.port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal(listed.json.result.tools.length, 1);
    assert.equal(listed.json.result.tools[0].name, "pink_system_query");
    assert.equal(listed.json.result.tools[0].inputSchema.type, "object");

    const called = await post(server.port, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "pink_system_query", arguments: { section: "info" } },
    });
    assert.equal(called.json.result.isError, false);
    assert.equal(called.json.result.content[0].text, "{\"version\":\"0.0.2\"}");
    assert.deepEqual(calls[0].args, { section: "info" });

    const missing = await post(server.port, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "pink_assets_delete", arguments: {} },
    });
    assert.equal(missing.json.result.isError, true);
    assert.match(missing.json.result.content[0].text, /Unknown tool/);
    assert.equal(calls.length, 1);
  } finally {
    await server.close();
  }
});

test("tool failures and cancellation become isError results", async () => {
  const server = await startMcpServer({
    port: 0,
    listTools: () => [{ name: "pink_scene_query", description: "scene", inputSchema: { type: "object" } }],
    callTool: (name, args, signal) => new Promise((resolve, reject) => {
      if (args.fail) {
        reject(new Error("Confirm the write again."));
        return;
      }
      signal.addEventListener("abort", () => reject(new Error("Cancelled")));
    }),
  });
  try {
    const failed = await post(server.port, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "pink_scene_query", arguments: { fail: true } },
    });
    assert.equal(failed.json.result.isError, true);
    assert.match(failed.json.result.content[0].text, /Confirm the write again/);

    const pending = post(server.port, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "pink_scene_query", arguments: {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const cancel = await post(server.port, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 8 },
    });
    assert.equal(cancel.status, 202);
    const cancelled = await pending;
    assert.equal(cancelled.json.result.isError, true);
    assert.match(cancelled.json.result.content[0].text, /Cancelled/);
  } finally {
    await server.close();
  }
});

function post(port, message, options) {
  return request(port, "POST", "/mcp", JSON.stringify(message), options);
}

function request(port, method, path, body, options) {
  const extra = options || {};
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    Host: extra.host || "127.0.0.1:" + port,
  };
  if (extra.token !== undefined) headers.Authorization = "Bearer " + extra.token;
  else headers.Authorization = "Bearer secret";
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json;
        if (raw) json = JSON.parse(raw);
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
