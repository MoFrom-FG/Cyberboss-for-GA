const fs = require("fs");
const path = require("path");

class RuntimeContextStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { contextsByWorkspaceRoot: {} };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.contextsByWorkspaceRoot) {
        this.state = {
          contextsByWorkspaceRoot: normalizeContextMap(parsed.contextsByWorkspaceRoot),
        };
      }
    } catch {
      this.state = { contextsByWorkspaceRoot: {} };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  setActiveContext({
    workspaceRoot = "",
    runtimeId = "",
    threadId = "",
    bindingKey = "",
    accountId = "",
    senderId = "",
  } = {}) {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return null;
    }
    const next = {
      workspaceRoot: normalizedWorkspaceRoot,
      runtimeId: normalizeText(runtimeId),
      threadId: normalizeText(threadId),
      bindingKey: normalizeText(bindingKey),
      accountId: normalizeText(accountId),
      senderId: normalizeText(senderId),
      updatedAt: new Date().toISOString(),
    };
    this.state.contextsByWorkspaceRoot = {
      ...(this.state.contextsByWorkspaceRoot || {}),
      [normalizedWorkspaceRoot]: next,
    };
    this.save();
    return next;
  }

  resolveActiveContext({ workspaceRoot = "", runtimeId = "" } = {}) {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
    if (normalizedWorkspaceRoot) {
      const exact = this.state.contextsByWorkspaceRoot?.[normalizedWorkspaceRoot];
      if (exact) {
        return exact;
      }
    }

    const entries = Object.values(this.state.contextsByWorkspaceRoot || {})
      .filter((entry) => entry && typeof entry === "object");
    const normalizedRuntimeId = normalizeText(runtimeId);
    const scoped = normalizedRuntimeId
      ? entries.filter((entry) => normalizeText(entry.runtimeId) === normalizedRuntimeId)
      : entries;
    const sorted = scoped.sort((left, right) => {
      const leftMs = Date.parse(left.updatedAt || "") || 0;
      const rightMs = Date.parse(right.updatedAt || "") || 0;
      return rightMs - leftMs;
    });
    return sorted[0] || null;
  }
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

function normalizeContextMap(raw) {
  const output = {};
  for (const [rawKey, entry] of Object.entries(raw || {})) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const workspaceRoot = normalizeWorkspaceRoot(entry.workspaceRoot || rawKey);
    if (!workspaceRoot) {
      continue;
    }
    const next = {
      ...entry,
      workspaceRoot,
    };
    const existing = output[workspaceRoot];
    const existingMs = Date.parse(existing?.updatedAt || "") || 0;
    const nextMs = Date.parse(next.updatedAt || "") || 0;
    if (!existing || nextMs >= existingMs) {
      output[workspaceRoot] = next;
    }
  }
  return output;
}

module.exports = { RuntimeContextStore, normalizeWorkspaceRoot };
