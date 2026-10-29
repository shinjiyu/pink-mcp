"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const registry = require("./registry");
const { startMcpServer, proxyTool } = require("./server");

const PREFIX = "pink_";
let current;
let takeoverTimer;

function activate(context) {
  if (!runningInPink()) return;

  const channel = vscode.window.createOutputChannel("PinK MCP");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "pinkMcp.copyConfig";
  context.subscriptions.push(channel, status);

  context.subscriptions.push(
    vscode.commands.registerCommand("pinkMcp.copyConfig", () => copyConfig(channel)),
    vscode.commands.registerCommand("pinkMcp.restart", () => restart(channel, status)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("pinkMcp")) restart(channel, status);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => restart(channel, status))
  );

  const timer = setInterval(() => refreshStatus(status), 2000);
  const stopTimer = setTimeout(() => clearInterval(timer), 60000);
  context.subscriptions.push({
    dispose() {
      clearInterval(timer);
      clearTimeout(stopTimer);
      if (takeoverTimer) clearInterval(takeoverTimer);
      if (current) {
        registry.removeInstance(stateDir(), current.instance && current.instance.id);
        return current.close();
      }
    },
  });

  return restart(channel, status);
}

function deactivate() {
  if (takeoverTimer) clearInterval(takeoverTimer);
  if (current) {
    registry.removeInstance(stateDir(), current.instance && current.instance.id);
    return current.close();
  }
}

async function restart(channel, status) {
  if (current) {
    const closing = current;
    current = undefined;
    registry.removeInstance(stateDir(), closing.instance && closing.instance.id);
    await closing.close();
  }
  const config = vscode.workspace.getConfiguration("pinkMcp");
  const preferred = normalizePort(config.get("port"));
  const allowInsecure = Boolean(config.get("allowInsecureNoToken"));
  const exposeWrites = Boolean(config.get("exposeWrites"));
  const token = registry.readToken(stateDir(), config.get("token"));
  if (!token && !allowInsecure) {
    const message = "PinK MCP 没有令牌。检查 ~/.pink/mcp/token 的权限，或在设置里填写 pinkMcp.token。";
    channel.appendLine(message);
    vscode.window.showErrorMessage(message);
    status.hide();
    return;
  }
  const identity = collectIdentity();
  try {
    current = await startMcpServer({
      port: preferred,
      listenMode: "auto",
      token,
      requireToken: !allowInsecure,
      exposeWrites,
      toolPrefix: PREFIX,
      instance: identity,
      log: (line) => channel.appendLine(redact(line, token)),
      listTools,
      callTool,
      listInstances: () => registry.prune(stateDir()).map(registry.publicInstance),
      currentSelection: () => currentSelection(),
      useInstance,
      resolveTarget: () => resolveTarget(),
      proxyTool: (target, name, args, signal) => proxyTool(target, name, args, token, signal),
    });
    identity.port = current.port;
    identity.role = current.port === preferred ? "gateway" : "instance";
    current.instance = identity;
    registry.upsertInstance(stateDir(), identity);
    channel.appendLine(listedCount() + " pink_* tools · " + describeInstance(identity));
    refreshStatus(status);
    status.show();
    watchGateway(channel, status, preferred);
  } catch (error) {
    status.hide();
    const message = error && error.message ? error.message : String(error);
    channel.appendLine(message);
    vscode.window.showErrorMessage(message);
  }
}

function collectIdentity() {
  const folders = (vscode.workspace.workspaceFolders || [])
    .map((folder) => folder.uri && folder.uri.fsPath)
    .filter(Boolean);
  const projectPath = folders[0] || "";
  return {
    id: crypto.randomUUID(),
    pid: process.pid,
    port: 0,
    projectPath,
    projectName: projectPath ? path.basename(projectPath) : "(no folder)",
    folders,
    sessionId: vscode.env.sessionId,
    role: "instance",
    startedAt: new Date().toISOString(),
  };
}

function listTools() {
  const tools = vscode.lm && Array.isArray(vscode.lm.tools) ? vscode.lm.tools : [];
  return tools
    .filter((tool) => tool && typeof tool.name === "string" && tool.name.startsWith(PREFIX))
    .map((tool) => ({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: tool.inputSchema,
    }));
}

async function callTool(name, args, signal) {
  if (!vscode.lm || typeof vscode.lm.invokeTool !== "function") {
    throw new Error("当前 PinK 没有 vscode.lm.invokeTool。");
  }
  const source = new vscode.CancellationTokenSource();
  const onAbort = () => source.cancel();
  if (signal && signal.aborted) source.cancel();
  else if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await vscode.lm.invokeTool(name, {
      input: args,
      toolInvocationToken: undefined,
    }, source.token);
    return require("./server").textFromToolResult(result);
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    source.dispose();
  }
}

function currentSelection() {
  const dir = stateDir();
  const instances = registry.prune(dir);
  return registry.resolveSelection(instances, registry.loadSelection(dir));
}

function useInstance(args) {
  const dir = stateDir();
  const instances = registry.prune(dir);
  const wanted = {
    instanceId: args && typeof args.instanceId === "string" ? args.instanceId : "",
    projectPath: args && typeof args.projectPath === "string" ? args.projectPath : "",
  };
  const selected = registry.resolveSelection(instances, wanted);
  if (!selected) return null;
  registry.saveSelection(dir, {
    instanceId: selected.id,
    projectPath: selected.projectPath,
    updatedAt: new Date().toISOString(),
  });
  return selected;
}

function resolveTarget() {
  const selected = currentSelection();
  if (!selected) {
    const live = registry.prune(stateDir());
    if (live.length <= 1) return { local: true };
    return null;
  }
  if (current && selected.id === current.instance.id) return { local: true };
  return { port: selected.port };
}

function copyConfig(channel) {
  const snippet = configSnippet();
  vscode.env.clipboard.writeText(snippet);
  const count = listedCount();
  channel.appendLine("copied Cursor config, " + count + " tools · token not written to this log");
  vscode.window.showInformationMessage("已复制 PinK MCP 配置（当前 " + count + " 个 pink_* 工具）。粘贴到 Cursor 的 mcp.json。令牌已写入剪贴板，不要发到聊天里。");
}

function configSnippet() {
  const config = vscode.workspace.getConfiguration("pinkMcp");
  const preferred = normalizePort(config.get("port"));
  const token = registry.readToken(stateDir(), config.get("token"));
  const gateway = current && current.port === preferred ? current.port : preferred;
  const server = { url: "http://127.0.0.1:" + gateway + "/mcp" };
  if (token) server.headers = { Authorization: "Bearer " + token };
  return JSON.stringify({ mcpServers: { pink: server } }, null, 2);
}

function refreshStatus(status) {
  if (!current) return;
  const count = listedCount();
  const identity = current.instance || {};
  const mark = identity.role === "gateway" ? "" : " :" + current.port;
  status.text = "$(plug) PinK MCP " + count + " · " + (identity.projectName || "PinK") + mark;
  status.tooltip = [
    current.url,
    describeInstance(identity),
    count + " 个 pink_* 工具",
    "点击复制 Cursor 配置（含令牌，不要发到聊天）",
  ].join("\n");
}

function listedCount() {
  const config = vscode.workspace.getConfiguration("pinkMcp");
  const { normalizeTools } = require("./server");
  return normalizeTools(listTools(), PREFIX, Boolean(config.get("exposeWrites"))).length;
}

function describeInstance(identity) {
  return (identity.role || "instance") + " · " + (identity.projectPath || identity.projectName || "no-folder");
}

function watchGateway(channel, status, preferred) {
  if (takeoverTimer) clearInterval(takeoverTimer);
  takeoverTimer = setInterval(() => {
    if (!current || current.port === preferred) return;
    probePort(preferred).then((busy) => {
      if (!busy) {
        channel.appendLine("gateway port " + preferred + " is free, taking over");
        return restart(channel, status);
      }
    }).catch(() => {});
  }, 4000);
}

function probePort(port) {
  return new Promise((resolve) => {
    const socket = require("net").connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(300, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function redact(line, token) {
  if (!token || !line) return line;
  return String(line).split(token).join("[token]");
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return 37720;
  return port;
}

function stateDir() {
  const config = vscode.workspace.getConfiguration("pinkMcp");
  const override = config.get("stateDir");
  if (typeof override === "string" && override.trim()) return override.trim();
  return registry.defaultDir();
}

function runningInPink() {
  try {
    const product = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, "product.json"), "utf8"));
    const name = String(product.nameShort || product.applicationName || "");
    return name.toLowerCase() === "pink";
  } catch (error) {
    return false;
  }
}

module.exports = { activate, deactivate };
