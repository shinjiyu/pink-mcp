"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const VERSION = "0.2.0";
const ID = "local.pink-mcp";
const FOLDER = "local.pink-mcp-" + VERSION;
const FILES = ["package.json", "extension.js", "server.js", "registry.js"];

function main() {
  const repo = path.join(__dirname, "..");
  const extensionsDir = path.join(os.homedir(), ".pink", "extensions");
  const target = path.join(extensionsDir, FOLDER);
  fs.mkdirSync(target, { recursive: true });
  for (const file of FILES) {
    fs.copyFileSync(path.join(repo, file), path.join(target, file));
  }

  const listFile = path.join(extensionsDir, "extensions.json");
  const list = readJson(listFile, []);
  const location = target;
  const entry = {
    identifier: { id: ID },
    version: VERSION,
    location: { $mid: 1, fsPath: location, external: "file://" + location, path: location, scheme: "file" },
    relativeLocation: FOLDER,
    metadata: {
      isApplicationScoped: false,
      isMachineScoped: false,
      isBuiltin: false,
      installedTimestamp: Date.now(),
      pinned: true,
      source: "vsix",
    },
  };
  const next = list.filter((item) => !item || !item.identifier || item.identifier.id !== ID);
  next.push(entry);
  writeJson(listFile, next);

  const obsoleteFile = path.join(extensionsDir, ".obsolete");
  const obsolete = readJson(obsoleteFile, {});
  let changed = false;
  for (const name of fs.readdirSync(extensionsDir)) {
    if (name.startsWith("local.pink-mcp-") && name !== FOLDER) {
      obsolete[name] = true;
      changed = true;
    }
  }
  if (changed) writeJson(obsoleteFile, obsolete);

  process.stdout.write("installed " + target + "\n");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

main();
