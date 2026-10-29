"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { textFromToolResult, normalizeTools, startMcpServer, mcpPost } = require("../server");
const registry = require("../registry");

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

test("normalizeTools hides write tools unless exposeWrites", () => {
  const tools = [
    { name: "pink_assets_query_info", description: "info", inputSchema: { properties: { uuid: { type: "string" } }, required: ["uuid", "missing"] } },
    { name: "copilot_search", description: "no" },
    { name: "pink bad", description: "no" },
    { name: "pink_assets_delete", description: "delete", inputSchema: null },
  ];
  const hidden = normalizeTools(tools, "pink_", false);
  assert.deepEqual(hidden.map((tool) => tool.name), ["pink_assets_query_info"]);
  assert.equal(hidden[0].annotations.readOnlyHint, true);

  const shown = normalizeTools(tools, "pink_", true);
  assert.deepEqual(shown.map((tool) => tool.name), ["pink_assets_query_info", "pink_assets_delete"]);
  assert.equal(shown[1].annotations, undefined);
});

test("streamable HTTP lists and calls tools", async () => {
  const calls = [];
  const server = await startMcpServer({
    port: 0,
    token: "secret",
    toolPrefix: "pink_",
    instance: { id: "win-1", projectPath: "/tmp/game", projectName: "game", role: "gateway" },
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

    const missing = await post(server.port, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { token: "" });
    assert.equal(missing.status, 403);

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
    assert.equal(init.json.result.serverInfo.instance.projectName, "game");
    assert.equal(init.headers["mcp-session-id"], undefined);

    const note = await post(server.port, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(note.status, 202);
    assert.equal(note.raw, "");

    const get = await request(server.port, "GET", "/mcp");
    assert.equal(get.status, 405);

    const healthDenied = await request(server.port, "GET", "/health", null, { token: "" });
    assert.equal(healthDenied.status, 401);

    const health = await request(server.port, "GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.instance.id, "win-1");
    assert.ok(!JSON.stringify(health.json).includes("secret"));

    const listed = await post(server.port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = listed.json.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("pink_system_query"));
    assert.ok(names.includes("pink_mcp_list_instances"));
    assert.ok(names.includes("pink_mcp_use_instance"));

    const called = await post(server.port, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "pink_system_query", arguments: { section: "info" } },
    });
    assert.equal(called.json.result.isError, false);
    assert.equal(called.json.result.content[0].text, "{\"version\":\"0.0.2\"}");
    assert.deepEqual(calls[0].args, { section: "info" });

    const unknown = await post(server.port, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "pink_assets_delete", arguments: {} },
    });
    assert.equal(unknown.json.result.isError, true);
    assert.match(unknown.json.result.content[0].text, /hidden|Unknown tool/);
    assert.equal(calls.length, 1);
  } finally {
    await server.close();
  }
});

test("tool failures and cancellation become isError results", async () => {
  const server = await startMcpServer({
    port: 0,
    token: "secret",
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

function deadPid() {
  for (let pid = 999999; pid > 990000; pid--) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error && error.code === "ESRCH") return pid;
    }
  }
  return 424242;
}

test("registry prunes dead pids and resolves a single live window", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pink-mcp-"));
  try {
    registry.upsertInstance(dir, {
      id: "dead",
      pid: deadPid(),
      port: 1,
      projectPath: "/tmp/old",
      projectName: "old",
    });
    registry.upsertInstance(dir, {
      id: "live",
      pid: process.pid,
      port: 37721,
      projectPath: "/tmp/game",
      projectName: "game",
    });
    const live = registry.prune(dir);
    assert.deepEqual(live.map((row) => row.id), ["live"]);
    const selected = registry.resolveSelection(live, { instanceId: "missing", projectPath: "/tmp/game" });
    assert.equal(selected.id, "live");
    const token = registry.readToken(dir, "");
    assert.ok(token.length >= 32);
    assert.equal(fs.statSync(path.join(dir, "token")).mode & 0o077, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gateway proxies pink_* to the selected instance", async () => {
  const token = "secret";
  const remote = await startMcpServer({
    port: 0,
    token,
    instance: { id: "game-b", projectPath: "/tmp/b", projectName: "b", role: "instance" },
    listTools: () => [{ name: "pink_system_query", description: "system", inputSchema: { type: "object", properties: {} } }],
    callTool: () => Promise.resolve("{\"from\":\"b\"}"),
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pink-mcp-"));
  try {
    registry.upsertInstance(dir, {
      id: "game-a",
      pid: process.pid,
      port: 9,
      projectPath: "/tmp/a",
      projectName: "a",
      role: "gateway",
    });
    registry.upsertInstance(dir, {
      id: "game-b",
      pid: process.pid,
      port: remote.port,
      projectPath: "/tmp/b",
      projectName: "b",
      role: "instance",
    });
    const gateway = await startMcpServer({
      port: 0,
      token,
      instance: { id: "game-a", projectPath: "/tmp/a", projectName: "a", role: "gateway" },
      listTools: () => [{ name: "pink_system_query", description: "system", inputSchema: { type: "object", properties: {} } }],
      callTool: () => Promise.resolve("{\"from\":\"a\"}"),
      listInstances: () => registry.prune(dir),
      currentSelection: () => registry.resolveSelection(registry.prune(dir), registry.loadSelection(dir)),
      useInstance: (args) => {
        const selected = registry.resolveSelection(registry.prune(dir), args);
        if (selected) registry.saveSelection(dir, { instanceId: selected.id, projectPath: selected.projectPath });
        return selected;
      },
      resolveTarget: () => {
        const selected = registry.resolveSelection(registry.prune(dir), registry.loadSelection(dir));
        if (!selected) return null;
        if (selected.id === "game-a") return { local: true };
        return { port: selected.port };
      },
      proxyTool: (target, name, args, signal) => require("../server").proxyTool(target, name, args, token, signal),
    });
    try {
      const listed = await mcpPost(gateway.port, token, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "pink_mcp_list_instances", arguments: {} },
      });
      const payload = JSON.parse(listed.json.result.content[0].text);
      assert.equal(payload.instances.length, 2);
      assert.ok(!JSON.stringify(payload).includes(token));

      const unset = await mcpPost(gateway.port, token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "pink_system_query", arguments: {} },
      });
      assert.equal(unset.json.result.isError, true);
      assert.match(unset.json.result.content[0].text, /pink_mcp_use_instance/);

      const picked = await mcpPost(gateway.port, token, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "pink_mcp_use_instance", arguments: { projectPath: "/tmp/b" } },
      });
      assert.equal(picked.json.result.isError, false);

      const proxied = await mcpPost(gateway.port, token, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "pink_system_query", arguments: {} },
      });
      assert.equal(proxied.json.result.isError, false);
      assert.equal(proxied.json.result.content[0].text, "{\"from\":\"b\"}");
    } finally {
      await gateway.close();
    }
  } finally {
    await remote.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("auto listen moves off a busy preferred port", async () => {
  const blocker = await startMcpServer({
    port: 0,
    token: "secret",
    listTools: () => [],
    callTool: () => "",
  });
  try {
    const moved = await startMcpServer({
      port: blocker.port,
      listenMode: "auto",
      token: "secret",
      listTools: () => [],
      callTool: () => "",
    });
    try {
      assert.notEqual(moved.port, blocker.port);
    } finally {
      await moved.close();
    }
  } finally {
    await blocker.close();
  }
});

function post(port, message, options) {
  return request(port, "POST", "/mcp", JSON.stringify(message), options);
}

function request(port, method, pathName, body, options) {
  const extra = options || {};
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    Host: extra.host || "127.0.0.1:" + port,
  };
  if (extra.token !== "") headers.Authorization = "Bearer " + (extra.token || "secret");
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: pathName, method, headers }, (res) => {
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
