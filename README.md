# PinK MCP

把正在运行的 PinK 里那组 `pink_*` 工具暴露成只监听本机的 MCP。Cursor 连 `http://127.0.0.1:37720/mcp`，查询会进当前选中的 PinK 窗口。

PinK 自己启动的 cocos-cli MCP 端点是关着的。这个插件不走那条端点，而是在 PinK 里调用 `vscode.lm.invokeTool`。

## 能调用的范围

默认只暴露只读工具（名字里带 `query` 或 `read`），例如资源、系统、构建平台、剪贴板读取。

写入和场景工具默认不出现在列表里。要暴露它们，在 PinK 里打开 `pinkMcp.exposeWrites`。即便如此，确认仍绑在 PinK 本地主 Chat 上，从 Cursor 调用通常会确认失败，不会绕过确认去改工程。

多开时先调 `pink_mcp_list_instances`，再用 `pink_mcp_use_instance` 选窗口。只开一个 PinK 窗口时会自动选中。

额外提供 `pink_mcp_execute_command`：在选中窗口里跑白名单命令（`pink.*` / `cocos.*`，以及打开资源、Reload、预览相关命令）。**不走** PinK Chat 确认，适合拉起编辑器预览；不能用来绕过 `pink_assets_*` / `pink_scene_*` 写入门禁。

场景绑定、截图、资源写入仍然需要 PinK 本地主 Chat 的 `toolInvocationToken`。从 Cursor / 外部 MCP 客户端直接 `invokeTool` 时没有这份身份，这些写入会失败。

## 安装

```bash
npm run install-pink
```

脚本会把 `package.json`、`extension.js`、`server.js`、`registry.js` 拷到 `~/.pink/extensions/local.pink-mcp-0.2.0/`，并写入 `extensions.json`。

完整退出 PinK 再打开，或在每个 PinK 窗口执行 Reload Window。只关一个窗口不会加载新插件。状态栏出现 `PinK MCP`、工程名和工具数量后，服务就在听端口。

## 接到 Cursor

PinK 要保持打开。令牌在 `~/.pink/mcp/token`，权限 `600`，不要贴进聊天。

在 Cursor 的 `mcp.json` 里加上：

```json
{
  "mcpServers": {
    "pink": {
      "url": "http://127.0.0.1:37720/mcp",
      "headers": {
        "Authorization": "Bearer <~/.pink/mcp/token 的内容>"
      }
    }
  }
}
```

也可以在 PinK 命令面板运行「PinK MCP: 复制 Cursor 配置」，把片段贴进已有的 `mcpServers`。复制结果带令牌，不要发到聊天里。

工具是 PinK 启动后才注册的。Cursor 里如果列表是空的，等状态栏数量上来，再刷新这个 MCP。

## 多开

每个 PinK 窗口单独听一个本机端口。第一个占用 `37720`（网关），其余从 `37721` 起往上找空位。登记写在 `~/.pink/mcp/instances.json`，死掉的进程会被清掉。

Cursor 始终连 `37720`。网关按当前选择把 `pink_*` 转到对应窗口。网关窗口关掉后，另一个窗口会在几秒内接管 `37720`。

## 设置

- `pinkMcp.port`：网关端口，默认 `37720`。只绑定 `127.0.0.1`。
- `pinkMcp.token`：覆盖本机令牌。留空则使用 `~/.pink/mcp/token`。
- `pinkMcp.exposeWrites`：默认 `false`。
- `pinkMcp.allowInsecureNoToken`：默认 `false`。不要开着。
- `pinkMcp.stateDir`：实例登记目录，留空为 `~/.pink/mcp`。

改完设置，或执行「PinK MCP: 重启服务」。

## 开发

```bash
npm test
```
