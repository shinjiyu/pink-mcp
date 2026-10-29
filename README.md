# PinK MCP

把正在运行的 PinK 里那组 `pink_*` 工具暴露成只监听本机的 MCP。Cursor 连 `http://127.0.0.1:37720/mcp`，查询会进当前打开的 PinK 项目。

PinK 自己启动的 cocos-cli MCP 端点是关着的。这个插件不走那条端点，而是在 PinK 里调用 `vscode.lm.invokeTool`。

## 能调用的范围

查询走当前活动项目，例如资源、系统、构建平台、剪贴板读取。

写入和场景工具也会出现在列表里。它们的确认绑在 PinK 本地主 Chat 上，从 Cursor 调用会拿到确认失败，不会绕过确认去改工程。

## 安装

把这个目录拷到：

`%USERPROFILE%\.pink\extensions\local.pink-mcp-0.1.0\`

需要这些文件：`package.json`、`extension.js`、`server.js`。

完整退出 PinK 再打开，或在 PinK 里执行 Reload Window。只关一个窗口不会加载新插件。状态栏出现 `PinK MCP` 和工具数量后，服务就在听端口。

## 接到 Cursor

PinK 要保持打开。在 Cursor 的 `mcp.json` 里加上：

```json
{
  "mcpServers": {
    "pink": {
      "url": "http://127.0.0.1:37720/mcp"
    }
  }
}
```

也可以在 PinK 命令面板运行「PinK MCP: 复制 Cursor 配置」，把片段贴进已有的 `mcpServers`。

工具是 PinK 启动后才注册的。Cursor 里如果列表是空的，等状态栏数量上来，再刷新这个 MCP。

## 设置

- `pinkMcp.port`：默认 `37720`。只绑定 `127.0.0.1`。
- `pinkMcp.token`：留空不校验。填写后，Cursor 要带请求头：

```json
{
  "mcpServers": {
    "pink": {
      "url": "http://127.0.0.1:37720/mcp",
      "headers": {
        "Authorization": "Bearer 你的 token"
      }
    }
  }
}
```

改完设置，或执行「PinK MCP: 重启服务」。

## 开发

```bash
npm test
```
