"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

function defaultDir() {
  return path.join(os.homedir(), ".pink", "mcp");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (error) {
    // chmod can fail on some filesystems; directory still exists
  }
}

function readToken(dir, override) {
  if (typeof override === "string" && override.trim()) return override.trim();
  ensureDir(dir);
  const file = path.join(dir, "token");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= 16) {
      try {
        fs.chmodSync(file, 0o600);
      } catch (error) {
        // keep existing token even if chmod fails
      }
      return existing;
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
  const token = crypto.randomBytes(32).toString("hex");
  writeSecret(file, token);
  return token;
}

function writeSecret(file, text) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch (error) {
    // ignore
  }
}

function writeJsonSecure(file, value) {
  writeSecret(file, JSON.stringify(value, null, 2));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

function withLock(dir, fn) {
  ensureDir(dir);
  const lock = path.join(dir, "lock");
  const started = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      if (Date.now() - started > 2000) {
        try {
          fs.rmdirSync(lock);
        } catch (stale) {
          // another process may have taken it
        }
      } else {
        const until = Date.now() + 20;
        while (Date.now() < until) {
          // wait for the lock directory
        }
      }
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch (error) {
      // ignore
    }
  }
}

function loadInstances(dir) {
  const data = readJson(path.join(dir, "instances.json"), { instances: [] });
  return Array.isArray(data.instances) ? data.instances : [];
}

function saveInstances(dir, instances) {
  writeJsonSecure(path.join(dir, "instances.json"), { instances });
}

function prune(dir) {
  return withLock(dir, () => {
    const live = loadInstances(dir).filter((row) => pidAlive(row.pid));
    saveInstances(dir, live);
    return live;
  });
}

function publicInstance(row) {
  return {
    id: row.id,
    pid: row.pid,
    port: row.port,
    projectPath: row.projectPath || "",
    projectName: row.projectName || "",
    folders: Array.isArray(row.folders) ? row.folders : [],
    role: row.role || "instance",
    startedAt: row.startedAt || "",
  };
}

function upsertInstance(dir, instance) {
  return withLock(dir, () => {
    const next = loadInstances(dir).filter((row) => pidAlive(row.pid) && row.id !== instance.id);
    next.push(publicInstance(instance));
    saveInstances(dir, next);
    return next;
  });
}

function removeInstance(dir, id) {
  return withLock(dir, () => {
    const next = loadInstances(dir).filter((row) => row.id !== id && pidAlive(row.pid));
    saveInstances(dir, next);
    return next;
  });
}

function loadSelection(dir) {
  const data = readJson(path.join(dir, "selection.json"), null);
  return data && typeof data === "object" ? data : null;
}

function saveSelection(dir, selection) {
  writeJsonSecure(path.join(dir, "selection.json"), selection);
}

function resolveSelection(instances, selection) {
  if (!Array.isArray(instances) || instances.length === 0) return null;
  if (selection && typeof selection.instanceId === "string" && selection.instanceId) {
    const byId = instances.find((row) => row.id === selection.instanceId);
    if (byId) return byId;
  }
  if (selection && typeof selection.projectPath === "string" && selection.projectPath) {
    const matches = instances.filter((row) => row.projectPath === selection.projectPath);
    if (matches.length === 1) return matches[0];
  }
  if (instances.length === 1) return instances[0];
  return null;
}

module.exports = {
  defaultDir,
  readToken,
  pidAlive,
  prune,
  upsertInstance,
  removeInstance,
  loadInstances,
  loadSelection,
  saveSelection,
  resolveSelection,
  publicInstance,
};
