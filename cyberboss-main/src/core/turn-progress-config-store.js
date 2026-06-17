const fs = require("fs");
const path = require("path");

class TurnProgressConfigStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = {};
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this.state = normalizeTurnState(JSON.parse(raw));
    } catch {
      this.state = defaultTurnState();
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getState() {
    this.load();
    return { ...this.state };
  }

  setEnabled(enabled) {
    this.state = {
      enabled: Boolean(enabled),
      mode: "intermediate_replies",
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return { ...this.state };
  }
}

function formatTurnProgressStatus(state) {
  const normalized = normalizeTurnState(state);
  return normalized.enabled
    ? "长任务 turn 显示 已开启：微信会像以前一样显示中间回复和最终回复。"
    : "长任务 turn 显示 已关闭：微信只显示最终回复，不显示中间回复。";
}

function normalizeTurnState(value) {
  if (!value || typeof value !== "object") {
    return defaultTurnState();
  }
  return {
    enabled: value.enabled !== false,
    mode: "intermediate_replies",
    updatedAt: normalizeText(value.updatedAt),
  };
}

function defaultTurnState() {
  return {
    enabled: true,
    mode: "intermediate_replies",
    updatedAt: "",
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  TurnProgressConfigStore,
  formatTurnProgressStatus,
};
