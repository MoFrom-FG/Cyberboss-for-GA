const fs = require("fs");
const http = require("http");
const path = require("path");

try {
  require("dotenv").config({ path: path.join(process.cwd(), ".env"), override: true });
} catch {
  // ignore
}

try {
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), override: true });
} catch {
  // ignore
}

const rootDir = path.resolve(__dirname, "..");
const workspaceRoot = resolveWorkspaceRootEnv();
const port = String(process.env.CYBERBOSS_SHARED_PORT || "8765");
const listenUrl = `ws://127.0.0.1:${port}`;
const stateDir = resolveConfigPath(
  process.env.CYBERBOSS_STATE_DIR || path.resolve(rootDir, "..", "cyberboss-data"),
  workspaceRoot,
);
const logDir = path.join(stateDir, "logs");
const appServerPidFile = path.join(logDir, "shared-app-server.pid");
const bridgePidFile = path.join(logDir, "shared-wechat.pid");
const appServerLogFile = path.join(logDir, "shared-app-server.log");
const accountsDir = path.join(stateDir, "accounts");
const sessionFile = process.env.CYBERBOSS_SESSIONS_FILE || path.join(stateDir, "sessions.json");

function ensureLogDir() {
  fs.mkdirSync(logDir, { recursive: true });
}

function isPidAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return false;
  }
  try {
    process.kill(numeric, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    return raw ? Number.parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
}

function writePidFile(filePath, pid) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${pid}\n`, "utf8");
}

function removePidFileIfMatches(filePath, pid) {
  const current = readPidFile(filePath);
  if (current && current === pid) {
    fs.rmSync(filePath, { force: true });
  }
}

function checkReadyz() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: Number(port),
        path: "/readyz",
        timeout: 500,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForReadyz({ attempts = 10, delayMs = 300 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    if (await checkReadyz()) {
      return true;
    }
    await sleep(delayMs);
  }
  return false;
}

function openLogFile(filePath) {
  return fs.openSync(filePath, "a");
}

async function ensureSharedAppServer() {
  return { pid: 0, status: "skipped" };
}

function ensureBridgeNotRunning() {
  const pidFromFile = readPidFile(bridgePidFile);
  if (pidFromFile && isPidAlive(pidFromFile)) {
    return pidFromFile;
  }
  if (pidFromFile) {
    fs.rmSync(bridgePidFile, { force: true });
  }
  return 0;
}

function resolveCurrentAccountId() {
  const configuredAccountId = normalizeText(process.env.CYBERBOSS_ACCOUNT_ID);
  if (configuredAccountId) {
    return configuredAccountId;
  }
  if (!fs.existsSync(accountsDir)) {
    return "";
  }
  const entries = fs.readdirSync(accountsDir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".context-tokens.json"))
    .map((name) => {
      const fullPath = path.join(accountsDir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        return {
          accountId: normalizeText(parsed?.accountId),
          savedAt: parseTimestamp(parsed?.savedAt),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((entry) => entry.accountId);
  entries.sort((left, right) => right.savedAt - left.savedAt);
  return entries[0]?.accountId || "";
}

function resolveBoundThread(workspaceRoot, options = {}) {
  const target = resolveSharedThreadTarget(workspaceRoot, options);
  if (!target.threadId) {
    throw new Error(target.waitingReason || `no bound WeChat thread found for workspace: ${workspaceRoot}`);
  }
  return {
    threadId: target.threadId,
    workspaceRoot: target.workspaceRoot,
  };
}

function resolveSharedThreadTarget(workspaceRoot, options = {}) {
  if (!fs.existsSync(sessionFile)) {
    const waitingReason = `session file not found: ${sessionFile}`;
    if (options?.allowMissingThread) {
      return {
        threadId: "",
        workspaceRoot: normalizeWorkspaceRoot(workspaceRoot),
        source: "waiting",
        waitingReason,
      };
    }
    throw new Error(waitingReason);
  }
  const preferActiveWorkspace = Boolean(options?.preferActiveWorkspace);
  const allowMissingThread = Boolean(options?.allowMissingThread);
  const runtimeId = normalizeText(process.env.CYBERBOSS_RUNTIME || "genericagent");
  const data = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  const currentAccountId = resolveCurrentAccountId();
  const bindings = Object.values(data.bindings || {})
    .filter((binding) => !currentAccountId || normalizeText(binding?.accountId) === currentAccountId)
    .sort((left, right) => parseTimestamp(right?.updatedAt) - parseTimestamp(left?.updatedAt));

  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  const active = bindings
    .map((binding) => {
      const activeWorkspaceRoot = normalizeWorkspaceRoot(binding?.activeWorkspaceRoot);
      return {
        binding,
        workspaceRoot: activeWorkspaceRoot,
        companionThreadId: getCompanionThreadId(binding, runtimeId),
        workspaceThreadId: activeWorkspaceRoot ? getThreadId(binding, activeWorkspaceRoot, runtimeId) : "",
      };
    })
    .find((entry) => entry.workspaceRoot);

  if (preferActiveWorkspace && active) {
    if (active.companionThreadId) {
      return {
        threadId: active.companionThreadId,
        workspaceRoot: active.workspaceRoot,
        source: "companion",
        bindingKey: findBindingKey(data.bindings, active.binding),
      };
    }
    if (active.workspaceThreadId) {
      return {
        threadId: active.workspaceThreadId,
        workspaceRoot: active.workspaceRoot,
        source: "workspace",
        bindingKey: findBindingKey(data.bindings, active.binding),
      };
    }
    const waitingReason = [
      `active workspace has no bound ${runtimeId} thread: ${active.workspaceRoot}`,
      "If you just used /new, send a normal message first to create the new thread.",
    ].join("\n");
    if (allowMissingThread) {
      return {
        threadId: "",
        workspaceRoot: active.workspaceRoot,
        source: "waiting",
        bindingKey: findBindingKey(data.bindings, active.binding),
        waitingReason,
      };
    }
    throw new Error(waitingReason);
  }

  const exact = bindings.find((binding) => getCompanionThreadId(binding, runtimeId)
    || getThreadId(binding, normalizedWorkspaceRoot, runtimeId));
  if (exact) {
    const companionThreadId = getCompanionThreadId(exact, runtimeId);
    return {
      threadId: companionThreadId || getThreadId(exact, normalizedWorkspaceRoot, runtimeId),
      workspaceRoot: normalizedWorkspaceRoot,
      source: companionThreadId ? "companion" : "workspace",
      bindingKey: findBindingKey(data.bindings, exact),
    };
  }

  if (active?.companionThreadId || active?.workspaceThreadId) {
    return {
      threadId: active.companionThreadId || active.workspaceThreadId,
      workspaceRoot: active.workspaceRoot,
      source: active.companionThreadId ? "companion" : "workspace",
      bindingKey: findBindingKey(data.bindings, active.binding),
    };
  }

  if (allowMissingThread) {
    return {
      threadId: "",
      workspaceRoot: active?.workspaceRoot || normalizedWorkspaceRoot,
      source: "waiting",
      bindingKey: active ? findBindingKey(data.bindings, active.binding) : "",
      waitingReason: `no bound WeChat thread found for workspace: ${workspaceRoot}`,
    };
  }
  throw new Error(`no bound WeChat thread found for workspace: ${workspaceRoot}`);
}

function getThreadId(binding, workspaceRoot, runtimeId = "") {
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    return "";
  }
  const map = getThreadMapForRuntime(binding, runtimeId);
  return getWorkspaceMapValue(map, normalizedWorkspaceRoot);
}

function getThreadMapForRuntime(binding, runtimeId) {
  const normalizedRuntimeId = normalizeText(runtimeId);
  const runtimeMap = binding && typeof binding.threadIdByWorkspaceRootByRuntime === "object"
    ? binding.threadIdByWorkspaceRootByRuntime
    : {};
  const scoped = runtimeMap[normalizedRuntimeId];
  return scoped && typeof scoped === "object" ? scoped : {};
}

function getCompanionThreadId(binding, runtimeId = "") {
  const normalizedRuntimeId = normalizeText(runtimeId) || "default";
  const map = binding && typeof binding.companionThreadIdByRuntime === "object"
    ? binding.companionThreadIdByRuntime
    : {};
  return normalizeText(map[normalizedRuntimeId]);
}

function findBindingKey(bindings, targetBinding) {
  for (const [bindingKey, binding] of Object.entries(bindings || {})) {
    if (binding === targetBinding) {
      return bindingKey;
    }
  }
  return "";
}

function resolveWorkspaceRootEnv() {
  return normalizeWorkspaceRoot(process.env.CYBERBOSS_WORKSPACE_ROOT || path.resolve(rootDir, ".."));
}

function resolveConfigPath(value, baseDir) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }
  return path.resolve(baseDir || process.cwd(), normalized);
}

function parseTimestamp(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeWorkspaceRoot(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const resolved = path.resolve(normalized);
  return process.platform === "win32"
    ? resolved.replace(/\//g, "\\")
    : resolved;
}

function getWorkspaceMapValue(map, workspaceRoot) {
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  if (!map || typeof map !== "object" || !normalizedWorkspaceRoot) {
    return "";
  }
  if (normalizeText(map[normalizedWorkspaceRoot])) {
    return normalizeText(map[normalizedWorkspaceRoot]);
  }
  const normalizedKey = workspaceRootLookupKey(normalizedWorkspaceRoot);
  for (const [candidateRoot, value] of Object.entries(map)) {
    if (workspaceRootLookupKey(candidateRoot) === normalizedKey) {
      return normalizeText(value);
    }
  }
  return "";
}

function workspaceRootLookupKey(value) {
  const normalized = normalizeWorkspaceRoot(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  rootDir,
  port,
  listenUrl,
  stateDir,
  logDir,
  appServerPidFile,
  bridgePidFile,
  appServerLogFile,
  ensureLogDir,
  isPidAlive,
  readPidFile,
  writePidFile,
  removePidFileIfMatches,
  ensureSharedAppServer,
  ensureBridgeNotRunning,
  resolveBoundThread,
  resolveSharedThreadTarget,
  normalizeWorkspaceRoot,
};
