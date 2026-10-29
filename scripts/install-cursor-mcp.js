"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const registry = require("../registry");

function main() {
  const token = registry.readToken(registry.defaultDir(), "");
  const mcpFile = path.join(os.homedir(), ".cursor", "mcp.json");
  const current = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
  if (!current.mcpServers || typeof current.mcpServers !== "object") current.mcpServers = {};
  current.mcpServers.pink = {
    url: "http://127.0.0.1:37720/mcp",
    headers: { Authorization: "Bearer " + token },
  };
  fs.writeFileSync(mcpFile, JSON.stringify(current, null, 2) + "\n");
  process.stdout.write("updated " + mcpFile + " (pink url only, token not printed)\n");
}

main();
