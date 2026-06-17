"use strict";

const fs = require("fs");
const path = require("path");
const { SessionStore } = require("../shared/session-store");
const {
  buildInstructionRefreshText,
  loadWechatInstructions,
} = require("../shared-instructions");
const {
  GenericAgentProcessClient,
  outputFileName,
  sanitizePathSegment,
} = require("./process-client");
const { mapGenericAgentMessageToRuntimeEvent } = require("./events");
const { normalizeGenericAgentOutput } = require("./output-normalizer");

const MAX_RECOVERY_FILES = 8;
const MAX_RECOVERY_TEXT_CHARS = 12_000;
const MAX_RECOVERY_ENTRY_CHARS = 2_000;
const MAX_RECOVERY_LEDGER_RECORDS = 16;
const LEGACY_RECOVERY_CONTINUITY_GAP_MS = 10 * 60_000;
const LEDGER_FILE_NAME = "turns.jsonl";
const RECOVERY_TIME_ZONE = "Asia/Shanghai";
const CYBERBOSS_SYSTEM_FILE_NAME = "_cyberboss_system.md";

function createGenericAgentRuntimeAdapter(config, { wechatMemory = null } = {}) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "genericagent" });
  const clientsByThreadId = new Map();
  let listener = null;
  const agentMainPath = resolveAgentMainPath(config.gaAgentMainPath);
  const taskBaseDir = resolveTaskBaseDir(config, agentMainPath);

  function createClient({ threadId, workspaceRoot }) {
    const taskSpec = resolveTaskSpecForThread({ agentMainPath, taskBaseDir, threadId });
    const taskDir = taskSpec.taskDir;
    fs.mkdirSync(taskDir, { recursive: true });
    const cyberbossSystemFile = writeCyberbossSystemFile(taskDir, config);
    const client = new GenericAgentProcessClient({
      pythonPath: config.gaPythonPath || "python",
      agentMainPath,
      taskDir,
      taskArg: taskSpec.taskArg,
      extraSystemFile: cyberbossSystemFile,
      workspaceRoot,
      llmNo: config.gaLlmNo || 0,
      verbose: Boolean(config.gaVerbose),
      env: {
        ...withoutLegacyGenericAgentSystemEnv(process.env),
        CYBERBOSS_GA_ORIGIN_THREAD_ID: threadId,
        CYBERBOSS_GA_ORIGIN_WORKSPACE_ROOT: workspaceRoot,
        CYBERBOSS_GA_ARTIFACT_WORKSPACE_ROOT: path.dirname(agentMainPath),
      },
    });
    client.on("message", (message) => {
      const event = mapGenericAgentMessageToRuntimeEvent(message);
      if (event && listener) {
        listener(event, message);
      }
    });
    client.on("log", ({ stream, text }) => {
      const cleaned = String(text || "").trim();
      if (cleaned) {
        console[stream === "stderr" ? "error" : "log"](`[genericagent][${stream}] ${cleaned}`);
      }
    });
    client.on("error", (error) => {
      console.error(`[genericagent] process error: ${error.message}`);
    });
    clientsByThreadId.set(threadId, client);
    return client;
  }

  function getLiveClient(threadId) {
    const client = clientsByThreadId.get(threadId);
    if (!client?.alive) {
      clientsByThreadId.delete(threadId);
      return null;
    }
    return client;
  }

  function startClientTurn(client, { opening, threadId, turnId = "", text, ledger = null }) {
    const promise = opening
      ? client.startInitialTurn({ text, threadId, turnId })
      : client.sendNextTurn({ text, threadId, turnId });
    promise
      .then((result) => {
        if (!ledger) {
          return;
        }
        const outputRoundIndex = Number.isInteger(result?.roundIndex) ? result.roundIndex : ledger.roundIndex;
        const outputFile = outputFileName(outputRoundIndex);
        appendGenericAgentLedgerRecord(client.taskDir, {
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          threadId,
          turnId,
          turnIndex: ledger.turnIndex,
          role: "assistant",
          source: "genericagent",
          outputFile,
          text: result?.text || "",
          summaries: readOutputSummaries(path.join(client.taskDir, outputFile)),
        }).catch((error) => {
          console.error(`[genericagent] failed to append assistant ledger: ${error.message}`);
        });
      })
      .catch((error) => {
        console.error(`[genericagent] turn failed: ${error.message}`);
      });
  }

  return {
    describe() {
      return {
        id: "genericagent",
        kind: "runtime",
        command: `${config.gaPythonPath || "python"} ${agentMainPath}`,
        taskBaseDir,
        sessionsFile: config.sessionsFile,
      };
    },
    onEvent(nextListener) {
      if (typeof nextListener !== "function") {
        return () => {};
      }
      listener = nextListener;
      return () => {
        if (listener === nextListener) {
          listener = null;
        }
      };
    },
    getSessionStore() {
      return sessionStore;
    },
    async initialize() {
      fs.mkdirSync(taskBaseDir, { recursive: true });
      return {
        command: `${config.gaPythonPath || "python"} ${agentMainPath}`,
        models: [],
      };
    },
    async close() {
      const clients = [...clientsByThreadId.values()];
      clientsByThreadId.clear();
      await Promise.all(clients.map((client) => client.close().catch(() => {})));
    },
    async startFreshThreadDraft({ bindingKey, workspaceRoot }) {
      const currentThreadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      const companionThreadId = typeof sessionStore.getCompanionThreadId === "function"
        ? sessionStore.getCompanionThreadId(bindingKey)
        : "";
      if (currentThreadId) {
        const client = clientsByThreadId.get(currentThreadId);
        if (client) {
          await client.close().catch(() => {});
          clientsByThreadId.delete(currentThreadId);
        }
      }
      if (companionThreadId && companionThreadId !== currentThreadId) {
        const client = clientsByThreadId.get(companionThreadId);
        if (client) {
          await client.close().catch(() => {});
          clientsByThreadId.delete(companionThreadId);
        }
      }
      if (typeof sessionStore.clearCompanionThreadId === "function") {
        sessionStore.clearCompanionThreadId(bindingKey);
      }
      return { workspaceRoot };
    },
    async respondApproval({ requestId, decision, result = null }) {
      return {
        requestId,
        decision: decision === "accept" ? "accept" : "decline",
        result,
      };
    },
    async cancelTurn({ threadId, turnId }) {
      const client = clientsByThreadId.get(threadId);
      if (client) {
        await client.cancelTurn({ threadId, turnId });
      }
      return { threadId, turnId };
    },
    async resumeThread({ threadId, workspaceRoot }) {
      return { threadId, workspaceRoot };
    },
    async compactThread({ threadId, workspaceRoot }) {
      const client = getLiveClient(threadId);
      if (!client) {
        throw new Error("GenericAgent thread is not alive; send a normal message to start a fresh thread");
      }
      const turnId = `${threadId}-turn-${client.roundIndex + 2}`;
      writeCyberbossSystemFile(client.taskDir, config);
      startClientTurn(client, { opening: false, threadId, text: "/compact" });
      return { threadId, turnId, workspaceRoot };
    },
    async refreshThreadInstructions({ threadId, workspaceRoot }) {
      const client = getLiveClient(threadId);
      if (!client) {
        throw new Error("GenericAgent thread is not alive; send a normal message to start a fresh thread");
      }
      const turnId = `${threadId}-turn-${client.roundIndex + 2}`;
      writeCyberbossSystemFile(client.taskDir, config);
      startClientTurn(client, {
        opening: false,
        threadId,
        turnId,
        text: buildGenericAgentInstructionRefreshText(config, workspaceRoot),
      });
      return { threadId, turnId, workspaceRoot, status: "queued" };
    },
    async sendTextTurn({ bindingKey, workspaceRoot, text, metadata = {} }) {
      const companionTurn = isWechatCompanionTurn(metadata);
      let threadId = companionTurn && typeof sessionStore.getCompanionThreadId === "function"
        ? sessionStore.getCompanionThreadId(bindingKey)
        : "";
      if (!threadId && companionTurn) {
        threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      }
      if (!threadId) {
        threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      }
      if (threadId && companionTurn && typeof sessionStore.getCompanionThreadId === "function"
        && !sessionStore.getCompanionThreadId(bindingKey)
        && typeof sessionStore.setCompanionThreadId === "function") {
        sessionStore.setCompanionThreadId(bindingKey, threadId, sanitizeBindingMetadata(metadata));
      }
      let client = threadId ? getLiveClient(threadId) : null;
      let opening = false;
      let outboundText = text;
      let memorySystemBlock = "";

      if (!client) {
        if (threadId) {
          client = createClient({ threadId, workspaceRoot });
          rememberThreadBinding({ bindingKey, workspaceRoot, threadId, metadata, companionTurn });
          opening = true;
          const memoryArgs = {
            threadId,
            senderId: metadata.senderId,
          };
          const memoryBlock = buildWechatMemoryPromptBlock(wechatMemory, memoryArgs);
          memorySystemBlock = buildWechatMemorySystemPromptBlock(wechatMemory, memoryArgs);
          outboundText = buildGenericAgentRecoveryTurnText(config, text, workspaceRoot, {
            threadId,
            taskDir: client.taskDir,
            sessionStore,
            memoryBlock,
          });
        } else {
          threadId = createThreadId(workspaceRoot);
          client = createClient({ threadId, workspaceRoot });
          rememberThreadBinding({ bindingKey, workspaceRoot, threadId, metadata, companionTurn });
          opening = true;
          const memoryArgs = {
            threadId,
            senderId: metadata.senderId,
          };
          const memoryBlock = buildWechatMemoryPromptBlock(wechatMemory, memoryArgs);
          memorySystemBlock = buildWechatMemorySystemPromptBlock(wechatMemory, memoryArgs);
          outboundText = buildGenericAgentOpeningTurnText(config, text, workspaceRoot, memoryBlock);
        }
      } else {
        const memoryArgs = {
          threadId,
          senderId: metadata.senderId,
        };
        const memoryBlock = buildWechatMemoryPromptBlock(wechatMemory, memoryArgs);
        memorySystemBlock = buildWechatMemorySystemPromptBlock(wechatMemory, memoryArgs);
        outboundText = buildGenericAgentContinuationTurnText(config, text, workspaceRoot, memoryBlock);
      }

      writeCyberbossSystemFile(client.taskDir, config, { memorySystemBlock });
      const roundIndex = opening ? 0 : client.roundIndex + 1;
      const ledgerTurnIndex = nextGenericAgentLedgerTurnIndex(client.taskDir);
      const turnId = `${threadId}-turn-${ledgerTurnIndex + 1}`;
      await appendGenericAgentLedgerRecord(client.taskDir, {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        threadId,
        turnId,
        turnIndex: ledgerTurnIndex,
        role: "user",
        source: resolveLedgerSource(metadata),
        workspaceRoot,
        text: resolveLedgerInputText({ text, metadata }),
      });
      setImmediate(() => {
        startClientTurn(client, {
          opening,
          threadId,
          turnId,
          text: outboundText,
          ledger: {
            turnIndex: ledgerTurnIndex,
            roundIndex,
          },
        });
      });
      return { threadId, turnId };
    },
    getTranscriptStatus({ threadId = "" } = {}) {
      return describeGenericAgentTranscript({
        agentMainPath,
        taskBaseDir,
        threadId,
      });
    },
  };

  function rememberThreadBinding({ bindingKey, workspaceRoot, threadId, metadata = {}, companionTurn = false }) {
    if (companionTurn && typeof sessionStore.setCompanionThreadId === "function") {
      sessionStore.setCompanionThreadId(bindingKey, threadId, sanitizeBindingMetadata(metadata));
      return;
    }
    sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);
  }
}

function isWechatCompanionTurn(metadata = {}) {
  const provider = String(metadata?.provider || "").trim().toLowerCase();
  const source = String(metadata?.source || "").trim().toLowerCase();
  return provider === "weixin"
    || provider === "wechat"
    || provider === "system"
    || source === "wechat"
    || source === "system";
}

function sanitizeBindingMetadata(metadata = {}) {
  const next = { ...(metadata || {}) };
  if (String(next.provider || "").trim().toLowerCase() === "system"
    || String(next.source || "").trim().toLowerCase() === "system") {
    delete next.provider;
    delete next.source;
    delete next.originalText;
    delete next.receivedAt;
  }
  return next;
}

function withoutLegacyGenericAgentSystemEnv(env = {}) {
  const next = { ...env };
  delete next.CYBERBOSS_GA_SYSTEM_INJECTION;
  delete next.CYBERBOSS_GA_SYSTEM_FILE;
  delete next.CYBERBOSS_GA_DISABLE_SYSTEM_INJECTION;
  return next;
}

function createThreadId(workspaceRoot) {
  const workspaceName = sanitizePathSegment(path.basename(workspaceRoot || "workspace"));
  return `ga-${workspaceName}-${Date.now().toString(36)}`;
}

function buildWechatMemoryPromptBlock(wechatMemory, { threadId = "", senderId = "" } = {}) {
  if (!wechatMemory || typeof wechatMemory.buildPromptBlock !== "function") {
    return "";
  }
  try {
    return wechatMemory.buildPromptBlock({ threadId, senderId });
  } catch (error) {
    console.error(`[genericagent] failed to build WeChat memory prompt: ${error.message}`);
    return "";
  }
}

function buildWechatMemorySystemPromptBlock(wechatMemory, { threadId = "", senderId = "" } = {}) {
  if (!wechatMemory || typeof wechatMemory.buildSystemPromptBlock !== "function") {
    return "";
  }
  try {
    return wechatMemory.buildSystemPromptBlock({ threadId, senderId });
  } catch (error) {
    console.error(`[genericagent] failed to build WeChat system memory prompt: ${error.message}`);
    return "";
  }
}

function buildGenericAgentOpeningTurnText(config, text, workspaceRoot, memoryBlock = "") {
  return withGenericAgentWorkspaceContext(buildGenericAgentUserTurnText(text, memoryBlock), workspaceRoot);
}

function buildGenericAgentContinuationTurnText(config, text, workspaceRoot, memoryBlock = "") {
  const normalizedText = String(text || "").trim();
  const normalizedMemory = String(memoryBlock || "").trim();
  const userName = String(config.userName || "User").trim() || "User";
  const botName = String(config.botName || "CyberBoss").trim() || "CyberBoss";
  const reminder = [
    "CYBERBOSS WECHAT CONTINUATION CONTEXT",
    "Continue the existing WeChat thread using the active WeChat instructions and memory context.",
    `Configured user name: ${userName}.`,
    `Configured bot name: ${botName}.`,
    "Do not introduce yourself as GenericAgent, CyberBoss, a generic assistant, or a tool manager unless the user is clearly debugging the system.",
    "Treat prior transcript/history as read-only context, not as pending work.",
    "Do not continue old tasks, tool calls, plans, or unfinished intentions unless the current user message explicitly asks you to.",
    "",
    normalizedMemory,
    normalizedMemory ? "" : null,
    "Current user message:",
    normalizedText,
  ].filter((line) => line !== null).join("\n").trim();
  return withGenericAgentWorkspaceContext(reminder, workspaceRoot);
}

function buildGenericAgentRecoveryTurnText(config, text, workspaceRoot, {
  threadId = "",
  taskDir = "",
  sessionStore = null,
  memoryBlock = "",
} = {}) {
  const recoveryContext = buildGenericAgentRecoveryContext({ threadId, taskDir, sessionStore });
  const normalizedText = String(text || "").trim();
  const normalizedMemory = String(memoryBlock || "").trim();
  const recoveryBlock = [
    "CYBERBOSS GENERICAGENT LOGICAL THREAD RECOVERY",
    "This is a continuation of the existing WeChat logical thread, not a new conversation.",
    "Use the recovered context below to preserve continuity. If it is incomplete, infer cautiously and continue from the user's current message.",
    "Recovered transcript/history is read-only context, not pending work.",
    "Do not continue old tasks, tool calls, plans, or unfinished intentions unless the current user message explicitly asks you to.",
    "",
    recoveryContext || "(No previous bridge transcript was available.)",
  ].join("\n").trim();
  const shouldIncludeTurnMemory = !hasGenericAgentBridgeTranscript(recoveryContext);
  const combinedMemoryBlock = [
    recoveryBlock,
    shouldIncludeTurnMemory ? normalizedMemory : "",
  ].filter(Boolean).join("\n\n").trim();
  return withGenericAgentWorkspaceContext(
    buildGenericAgentUserTurnText(normalizedText, combinedMemoryBlock),
    workspaceRoot,
  );
}

function hasGenericAgentBridgeTranscript(recoveryContext = "") {
  return /(?:^|\n)Recent GenericAgent bridge transcript:\s*(?:\n|$)/.test(String(recoveryContext || ""));
}

function buildGenericAgentUserTurnText(text, memoryBlock = "") {
  const normalizedText = String(text || "").trim();
  const normalizedMemory = String(memoryBlock || "").trim();
  return [
    normalizedMemory,
    normalizedMemory ? "" : null,
    "Current user message:",
    normalizedText,
  ].filter((line) => line !== null && line !== "").join("\n").trim();
}

function buildGenericAgentInstructionRefreshText(config, workspaceRoot) {
  return withGenericAgentWorkspaceContext(buildInstructionRefreshText(config), workspaceRoot);
}

function buildCyberbossSystemInjection(config, { memorySystemBlock = "" } = {}) {
  const instructions = loadWechatInstructions(config);
  const normalizedMemorySystem = String(memorySystemBlock || "").trim();
  if (!instructions && !normalizedMemorySystem) {
    return "";
  }
  const sections = [];
  if (instructions) {
    sections.push([
    "CYBERBOSS WECHAT SESSION INSTRUCTIONS",
    "These instructions are scoped system context for this Cyberboss WeChat runtime thread.",
    "They are injected through the GenericAgent runtime bridge so they survive GA history trimming.",
    "Priority: for WeChat-channel task routing, these scoped rules are the active router. Do not fall back to GenericAgent desktop/global habits unless this router explicitly delegates there.",
    "These rules do not override higher-priority GenericAgent safety, verified-tool, or memory-management requirements.",
    "When asked about your own operating rules, SOPs, tools, or MCP availability in WeChat, answer from these WeChat-session rules instead of desktop Pro/global rules.",
    "",
    instructions,
    ].join("\n").trim());
  }
  if (normalizedMemorySystem) {
    sections.push(normalizedMemorySystem);
  }
  return sections.join("\n\n").trim();
}

function writeCyberbossSystemFile(taskDir, config, { memorySystemBlock = "" } = {}) {
  const normalizedTaskDir = String(taskDir || "").trim();
  if (!normalizedTaskDir) {
    return "";
  }
  const target = path.join(normalizedTaskDir, CYBERBOSS_SYSTEM_FILE_NAME);
  const text = buildCyberbossSystemInjection(config, { memorySystemBlock });
  try {
    fs.mkdirSync(normalizedTaskDir, { recursive: true });
    fs.writeFileSync(target, text ? `${text}\n` : "", "utf8");
    return target;
  } catch (error) {
    console.error(`[genericagent] failed to write Cyberboss system injection: ${error.message}`);
    return "";
  }
}

function withGenericAgentWorkspaceContext(text, workspaceRoot) {
  const normalizedWorkspaceRoot = String(workspaceRoot || "").trim();
  const normalizedText = String(text || "").trim();
  if (!normalizedWorkspaceRoot) {
    return normalizedText;
  }
  return [
    "CYBERBOSS GENERICAGENT RUNTIME CONTEXT",
    "Bound workspace root:",
    normalizedWorkspaceRoot,
    "",
    "Treat this bound workspace root as the user's project directory when reading files or running project commands.",
    "The GenericAgent --task directory is only the Cyberboss bridge mailbox for input.txt, reply.txt, and output*.txt.",
    "",
    normalizedText,
  ].join("\n").trim();
}

function resolveAgentMainPath(agentMainPath = "") {
  if (agentMainPath) {
    return agentMainPath;
  }
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "..", "..", "GenericAgent-main", "agentmain.py"),
    path.resolve(__dirname, "..", "..", "..", "..", "..", "..", "agentmain.py"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function resolveTaskBaseDir(config, agentMainPath) {
  const configured = String(config.gaTaskBaseDir || "").trim();
  if (configured) {
    return configured;
  }
  return path.resolve(__dirname, "..", "..", "..", "..", "..", "cyberboss-data", "genericagent-sessions");
}

function createTaskSpec({ agentMainPath, taskBaseDir, threadId, date = new Date() }) {
  const day = formatDateSegment(date);
  const taskDir = path.join(taskBaseDir, day, sanitizePathSegment(threadId));
  const agentTempDir = path.join(path.dirname(agentMainPath), "temp");
  return {
    taskDir,
    taskArg: toGenericAgentTaskArg(taskDir, agentTempDir),
  };
}

function resolveTaskSpecForThread({ agentMainPath, taskBaseDir, threadId, date = new Date() }) {
  const sanitizedThreadId = sanitizePathSegment(threadId);
  const existing = findExistingDatedTaskDir(taskBaseDir, sanitizedThreadId);
  const taskDir = existing || createTaskSpec({ agentMainPath, taskBaseDir, threadId, date }).taskDir;
  const agentTempDir = path.join(path.dirname(agentMainPath), "temp");
  return {
    taskDir,
    taskArg: toGenericAgentTaskArg(taskDir, agentTempDir),
  };
}

function findExistingDatedTaskDir(taskBaseDir, sanitizedThreadId) {
  let entries = [];
  try {
    entries = fs.readdirSync(taskBaseDir, { withFileTypes: true });
  } catch {
    return "";
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .map((name) => path.join(taskBaseDir, name, sanitizedThreadId))
    .find((candidate) => fs.existsSync(candidate)) || "";
}

function buildGenericAgentRecoveryContext({ threadId = "", taskDir = "", sessionStore = null } = {}) {
  const sections = [];
  const normalizedThreadId = String(threadId || "").trim();
  if (normalizedThreadId) {
    sections.push(`Thread id: ${normalizedThreadId}`);
  }

  const lastReplyText = getLastReplyText(sessionStore, normalizedThreadId);
  if (lastReplyText) {
    sections.push(["Last delivered reply:", truncateText(lastReplyText, MAX_RECOVERY_ENTRY_CHARS)].join("\n"));
  }

  const ledgerRecords = readGenericAgentLedgerRecords(taskDir);
  if (ledgerRecords.length) {
    sections.push([
      "Recent GenericAgent bridge transcript:",
      buildGenericAgentLedgerTranscript(ledgerRecords),
    ].join("\n\n"));
  } else {
    const entries = readGenericAgentRecoveryEntries(taskDir);
    if (entries.length) {
      sections.push([
        "Recent GenericAgent bridge transcript:",
        ...entries.map((entry) => [
          `### ${entry.label}`,
          truncateText(entry.text, MAX_RECOVERY_ENTRY_CHARS),
        ].join("\n")),
      ].join("\n\n"));
    }
  }

  return truncateText(sections.join("\n\n").trim(), MAX_RECOVERY_TEXT_CHARS);
}

function getLastReplyText(sessionStore, threadId) {
  if (!sessionStore || !threadId) {
    return "";
  }
  const raw = sessionStore.state?.runtimeThreadStateByThreadId?.[threadId]?.lastReplyText;
  return typeof raw === "string" ? raw.trim() : "";
}

function buildGenericAgentLedgerTranscript(records) {
  return filterRecoveryLedgerRecords(records)
    .slice(-MAX_RECOVERY_LEDGER_RECORDS)
    .map((record) => {
      const role = record.role === "assistant" ? "Assistant" : "User";
      const time = formatRecoveryRecordTime(record.createdAt);
      const bodyLines = [truncateText(record.text || "", MAX_RECOVERY_ENTRY_CHARS)];
      return `${role} [${time}]:\n${bodyLines.filter(Boolean).join("\n\n")}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function filterRecoveryLedgerRecords(records = []) {
  const allowedTurnIndexes = new Set();
  const allowedTurnIds = new Set();
  for (const record of records) {
    if (record.role !== "user") {
      continue;
    }
    if (!isRecoverableUserLedgerRecord(record)) {
      continue;
    }
    if (Number.isInteger(record.turnIndex)) {
      allowedTurnIndexes.add(record.turnIndex);
    }
    if (record.turnId) {
      allowedTurnIds.add(record.turnId);
    }
  }
  return records.filter((record) => {
    if (record.role === "user") {
      return isRecoverableUserLedgerRecord(record);
    }
    if (record.role !== "assistant") {
      return false;
    }
    if (Number.isInteger(record.turnIndex)) {
      return allowedTurnIndexes.has(record.turnIndex);
    }
    if (record.turnId) {
      return allowedTurnIds.has(record.turnId);
    }
    return true;
  });
}

function isRecoverableUserLedgerRecord(record = {}) {
  const source = String(record.source || "").trim().toLowerCase();
  return source !== "system" && source !== "command";
}

function formatRecoveryRecordTime(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "unknown time";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return normalized;
  }
  const iso = new Date(parsed).toISOString();
  return `${formatZonedDateTime(parsed, { includeSeconds: true })} ${RECOVERY_TIME_ZONE}; UTC ${iso}`;
}

function formatZonedDateTime(value, { includeSeconds = false } = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: RECOVERY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
    return result;
  }, {});
  const time = includeSeconds
    ? `${parts.hour}:${parts.minute}:${parts.second}`
    : `${parts.hour}:${parts.minute}`;
  return `${parts.year}-${parts.month}-${parts.day} ${time}`;
}

function readGenericAgentLedgerRecords(taskDir) {
  const text = readTextFile(path.join(taskDir || "", LEDGER_FILE_NAME));
  if (!text.trim()) {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((record) => (
      record
      && record.schemaVersion === 1
      && (record.role === "user" || record.role === "assistant")
      && typeof record.text === "string"
    ));
}

function nextGenericAgentLedgerTurnIndex(taskDir) {
  const userRecords = readGenericAgentLedgerRecords(taskDir)
    .filter((record) => record.role === "user" && Number.isInteger(record.turnIndex));
  if (!userRecords.length) {
    return 0;
  }
  return Math.max(...userRecords.map((record) => record.turnIndex)) + 1;
}

async function appendGenericAgentLedgerRecord(taskDir, record) {
  if (!taskDir) {
    return;
  }
  await fs.promises.mkdir(taskDir, { recursive: true });
  await fs.promises.appendFile(
    path.join(taskDir, LEDGER_FILE_NAME),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
}

function resolveLedgerInputText({ text = "", metadata = {} } = {}) {
  const originalText = typeof metadata.originalText === "string" ? metadata.originalText.trim() : "";
  return originalText || String(text || "").trim();
}

function resolveLedgerSource(metadata = {}) {
  const source = String(metadata.source || "").trim().toLowerCase();
  if (source === "system" || source === "command" || source === "wechat") {
    return source;
  }
  return metadata.provider === "system" ? "system" : "wechat";
}

function readOutputSummaries(filePath) {
  const text = readTextFile(filePath);
  return Array.from(text.matchAll(/<summary>\s*([\s\S]*?)\s*<\/summary>/gi))
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function describeGenericAgentTranscript({ agentMainPath = "", taskBaseDir = "", threadId = "" } = {}) {
  const normalizedThreadId = String(threadId || "").trim();
  if (!normalizedThreadId) {
    return "🗂 transcript: missing thread";
  }
  const taskSpec = resolveTaskSpecForThread({ agentMainPath, taskBaseDir, threadId: normalizedThreadId });
  const taskDir = taskSpec.taskDir;
  if (!taskDir || !fs.existsSync(taskDir)) {
    return "🗂 transcript: missing taskDir";
  }

  const ledgerCount = readGenericAgentLedgerRecords(taskDir).length;
  const outputCount = countCurrentOutputFiles(taskDir);
  if (ledgerCount > 0) {
    return `🗂 transcript: ledger ${ledgerCount} turns | taskDir ok | current outputs ${outputCount}`;
  }
  if (outputCount > 0) {
    return `🗂 transcript: legacy outputs only; recovery may be partial | taskDir ok | current outputs ${outputCount}`;
  }
  return `🗂 transcript: empty | taskDir ok | current outputs ${outputCount}`;
}

function countCurrentOutputFiles(taskDir) {
  try {
    return fs.readdirSync(taskDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^output\d*\.txt$/i.test(entry.name))
      .length;
  } catch {
    return 0;
  }
}

function readGenericAgentRecoveryEntries(taskDir) {
  if (!taskDir) {
    return [];
  }
  return selectRecentLegacyRecoveryWindow(collectLegacyRecoveryFiles(taskDir));
}

function collectLegacyRecoveryFiles(taskDir) {
  const dirs = [taskDir, ...listRunArchiveDirs(taskDir)];
  const result = [];
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !isLegacyRecoveryFileName(entry.name)) {
        continue;
      }
      const filePath = path.join(dir, entry.name);
      const stat = safeStat(filePath);
      if (!stat) {
        continue;
      }
      const raw = readTextFile(filePath);
      const text = entry.name.toLowerCase() === "input.txt" ? raw.trim() : extractRecoveryText(raw);
      if (!text) {
        continue;
      }
      const relativeName = path.relative(taskDir, filePath).split(path.sep).join("/");
      const isInput = entry.name.toLowerCase() === "input.txt";
      result.push({
        label: isInput
          ? (relativeName === "input.txt" ? "Initial user message" : `User input ${relativeName}`)
          : `Assistant output ${relativeName}`,
        text,
        mtimeMs: stat.mtimeMs || 0,
      });
    }
  }
  return result;
}

function listRunArchiveDirs(taskDir) {
  const runsDir = path.join(taskDir, "runs");
  try {
    return fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(runsDir, entry.name));
  } catch {
    return [];
  }
}

function isLegacyRecoveryFileName(name) {
  return name.toLowerCase() === "input.txt" || /^output\d*\.txt$/i.test(name);
}

function selectRecentLegacyRecoveryWindow(files) {
  const sorted = files
    .filter(Boolean)
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
  const selected = [];
  for (let index = sorted.length - 1; index >= 0 && selected.length < MAX_RECOVERY_FILES; index -= 1) {
    const current = sorted[index];
    const newer = selected[selected.length - 1];
    if (newer && newer.mtimeMs - current.mtimeMs > LEGACY_RECOVERY_CONTINUITY_GAP_MS) {
      break;
    }
    selected.push(current);
  }
  return selected.reverse();
}

function extractRecoveryText(raw) {
  const text = String(raw || "").replace(/\[ROUND END\]/g, "").trim();
  if (!text) {
    return "";
  }
  const summaries = Array.from(text.matchAll(/<summary>\s*([\s\S]*?)\s*<\/summary>/gi))
    .map((match) => match[1].trim())
    .filter(Boolean);
  const visible = normalizeGenericAgentOutput(text).trim();
  return [
    summaries.length ? `Internal summaries:\n${summaries.map((summary) => `- ${summary}`).join("\n")}` : "",
    visible ? `Visible reply:\n${visible}` : "",
  ].filter(Boolean).join("\n\n").trim();
}

function outputFileIndex(name) {
  const match = /^output(\d*)\.txt$/i.exec(String(name || ""));
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }
  return match[1] ? Number.parseInt(match[1], 10) : 0;
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function truncateText(text, maxChars) {
  const normalized = String(text || "").trim();
  if (!normalized || normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 80).trimEnd()}\n\n[...truncated ${normalized.length - maxChars + 80} chars...]`;
}

function toGenericAgentTaskArg(taskDir, agentTempDir) {
  const relative = path.relative(agentTempDir, taskDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return taskDir;
  }
  return relative.split(path.sep).join("/");
}

function formatDateSegment(date) {
  const value = date instanceof Date ? date : new Date();
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

module.exports = {
  createGenericAgentRuntimeAdapter,
  createTaskSpec,
  buildGenericAgentOpeningTurnText,
  buildGenericAgentContinuationTurnText,
  resolveTaskSpecForThread,
  buildWechatMemoryPromptBlock,
  buildWechatMemorySystemPromptBlock,
  buildCyberbossSystemInjection,
  buildGenericAgentRecoveryContext,
  buildGenericAgentRecoveryTurnText,
  describeGenericAgentTranscript,
  formatDateSegment,
  resolveAgentMainPath,
  resolveTaskBaseDir,
  toGenericAgentTaskArg,
};
