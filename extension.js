"use strict";

const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { textFromToolResult, startMcpServer } = require("./server");

const PREFIX = "pink_";
let current;

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
    })
  );

  const timer = setInterval(() => refreshStatus(status), 2000);
  const stopTimer = setTimeout(() => clearInterval(timer), 60000);
  context.subscriptions.push({
    dispose() {
      clearInterval(timer);
      clearTimeout(stopTimer);
      if (current) current.close();
    },
  });

  return restart(channel, status);
}

function deactivate() {
  if (current) return current.close();
}

async function restart(channel, status) {
  if (current) {
    const closing = current;
    current = undefined;
    await closing.close();
  }
  const config = vscode.workspace.getConfiguration("pinkMcp");
  const port = normalizePort(config.get("port"));
  const token = typeof config.get("token") === "string" ? config.get("token") : "";
  try {
    current = await startMcpServer({
      port,
      token,
      toolPrefix: PREFIX,
      log: (line) => channel.appendLine(line),
      listTools,
      callTool,
    });
    channel.appendLine(listedCount() + " pink_* tools");
    refreshStatus(status);
    status.show();
  } catch (error) {
    status.hide();
    const message = error && error.code === "EADDRINUSE"
      ? "端口 " + port + " 已被占用，改 pinkMcp.port 后再执行「PinK MCP: 重启服务」。"
      : (error && error.message ? error.message : String(error));
    channel.appendLine(message);
    vscode.window.showErrorMessage(message);
  }
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
    return textFromToolResult(result);
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    source.dispose();
  }
}

function copyConfig(channel) {
  const snippet = configSnippet();
  vscode.env.clipboard.writeText(snippet);
  const count = listedCount();
  channel.appendLine("copied Cursor config, " + count + " tools");
  vscode.window.showInformationMessage("已复制 PinK MCP 配置（当前 " + count + " 个 pink_* 工具）。粘贴到 Cursor 的 mcp.json。");
}

function configSnippet() {
  const config = vscode.workspace.getConfiguration("pinkMcp");
  const port = current ? current.port : normalizePort(config.get("port"));
  const token = typeof config.get("token") === "string" ? config.get("token") : "";
  const server = { url: "http://127.0.0.1:" + port + "/mcp" };
  if (token) server.headers = { Authorization: "Bearer " + token };
  return JSON.stringify({ mcpServers: { pink: server } }, null, 2);
}

function refreshStatus(status) {
  if (!current) return;
  const count = listedCount();
  status.text = "$(plug) PinK MCP " + count;
  status.tooltip = current.url + "\n" + count + " 个 pink_* 工具\n点击复制 Cursor 配置";
}

function listedCount() {
  return listTools().length;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return 37720;
  return port;
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
