const fs = require("fs");
const path = require("path");

/**
 * SubagentWatcher — lightweight filesystem poller that detects
 * subagent completions and enqueues system messages so the
 * WeChat bot can notify the user in near-real-time.
 *
 * No LLM, no subprocess — just a setInterval poll inside the
 * cyberboss Node process.
 */
class SubagentWatcher {
  /**
   * @param {object} opts
   * @param {import("../tools/runtime-context-store").RuntimeContextStore} opts.runtimeContextStore
   * @param {import("./system-message-queue-store").SystemMessageQueueStore} opts.queueStore
   * @param {string} [opts.accountId]
   * @param {string} [opts.senderId]
   * @param {number} [opts.pollIntervalMs=5000]
   */
  constructor({ runtimeContextStore, queueStore, accountId = "", senderId = "", pollIntervalMs = 5000 }) {
    this.runtimeContextStore = runtimeContextStore;
    this.queueStore = queueStore;
    this.accountId = normalizeText(accountId);
    this.senderId = normalizeText(senderId);
    this.pollIntervalMs = pollIntervalMs;
    this.timer = null;
  }

  setActiveTarget({ accountId = "", senderId = "" } = {}) {
    this.accountId = normalizeText(accountId);
    this.senderId = normalizeText(senderId);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.timer.unref?.(); // Let the process exit if this is the only timer
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  poll() {
    try {
      this.runtimeContextStore.load?.();
      const contexts = this.runtimeContextStore.state?.contextsByWorkspaceRoot || {};
      for (const [workspaceRoot, ctx] of Object.entries(contexts)) {
        const target = this.resolveNotificationTarget(ctx);
        if (!target) continue;
        const subagentDir = path.join(workspaceRoot, "temp", "subagent_works");
        if (!fs.existsSync(subagentDir)) continue;

        let entries;
        try {
          entries = fs.readdirSync(subagentDir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const taskName = entry.name;
          const taskDir = path.join(subagentDir, taskName);
          const outputPath = path.join(taskDir, "output.txt");
          if (!fs.existsSync(outputPath)) continue;

          // Skip if already notified (persistent marker, survives restarts)
          const notifiedPath = path.join(taskDir, ".notified");
          if (fs.existsSync(notifiedPath)) continue;

          // Read last non-empty line to check for completion marker
          let content;
          try {
            content = fs.readFileSync(outputPath, "utf-8");
          } catch {
            continue;
          }
          const lines = content.split("\n");
          let lastNonEmpty = "";
          for (let i = lines.length - 1; i >= 0; i--) {
            const trimmed = lines[i].trim();
            if (trimmed) {
              lastNonEmpty = trimmed;
              break;
            }
          }
          if (!lastNonEmpty.includes("[ROUND END]")) continue;

          const subagentContext = readSubagentContext(taskDir);
          const notificationWorkspaceRoot = subagentContext.originWorkspaceRoot || workspaceRoot;
          const artifactWorkspaceRoot = subagentContext.artifactWorkspaceRoot || workspaceRoot;
          const resultPath = path.join(artifactWorkspaceRoot, "temp", "subagent_works", taskName, "output.txt");

          // Enqueue system message
          const messageId = `subagent:${taskName}`;
          this.queueStore.enqueue({
            id: messageId,
            accountId: target.accountId,
            senderId: target.senderId,
            workspaceRoot: notificationWorkspaceRoot,
            text: `📋 Subagent \`${taskName}\` has completed. Check \`${resultPath}\` for results.`,
            mode: "subagent_result",
            createdAt: new Date().toISOString(),
          });

          // Persist notification marker so we never re-notify
          try {
            fs.writeFileSync(notifiedPath, new Date().toISOString(), "utf-8");
          } catch {
            // Non-fatal — if marker write fails we may re-notify on restart
          }
        }
      }
    } catch (err) {
      console.error("[subagent-watcher] poll error:", err.message);
    }
  }

  resolveNotificationTarget(ctx) {
    const contextAccountId = normalizeText(ctx?.accountId);
    const contextSenderId = normalizeText(ctx?.senderId);
    if (this.accountId && this.senderId) {
      return {
        accountId: this.accountId,
        senderId: this.senderId,
      };
    }
    if (!contextAccountId || !contextSenderId) {
      return null;
    }
    return {
      accountId: contextAccountId,
      senderId: contextSenderId,
    };
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readSubagentContext(taskDir) {
  try {
    const raw = fs.readFileSync(path.join(taskDir, "context.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return {
      originWorkspaceRoot: normalizeText(parsed.originWorkspaceRoot),
      originThreadId: normalizeText(parsed.originThreadId),
      artifactWorkspaceRoot: normalizeText(parsed.artifactWorkspaceRoot),
    };
  } catch {
    return {};
  }
}

module.exports = { SubagentWatcher };
