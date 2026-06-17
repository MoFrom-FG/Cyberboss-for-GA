"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const {
  normalizeGenericAgentLastTurnOutput,
  normalizeGenericAgentOutput,
  normalizeGenericAgentTurnOutputs,
} = require("./output-normalizer");

const POLL_INTERVAL_MS = 500;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
const ROUND_END_MARKER = "[ROUND END]";

class GenericAgentProcessClient extends EventEmitter {
  constructor({
    pythonPath = "python",
    agentMainPath = "",
    taskDir = "",
    taskArg = "",
    extraSystemFile = "",
    workspaceRoot = "",
    llmNo = 0,
    verbose = false,
    env = process.env,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
  } = {}) {
    super();
    this.pythonPath = pythonPath || "python";
    this.agentMainPath = agentMainPath;
    this.taskDir = taskDir;
    this.taskArg = taskArg;
    this.extraSystemFile = extraSystemFile;
    this.workspaceRoot = workspaceRoot;
    this.llmNo = Number.isInteger(llmNo) ? llmNo : 0;
    this.verbose = Boolean(verbose);
    this.env = {
      ...env,
      PYTHONUNBUFFERED: "1",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    };
    this.turnTimeoutMs = turnTimeoutMs;
    this.process = null;
    this.currentTurn = null;
    this.roundIndex = 0;
  }

  get alive() {
    return Boolean(this.process && !this.process.killed && this.process.exitCode == null);
  }

  async startInitialTurn({ text = "", threadId = "", turnId = "" }) {
    if (this.alive || this.currentTurn) {
      throw new Error("GenericAgent task process is already running");
    }
    await fs.promises.mkdir(this.taskDir, { recursive: true });
    await archiveExistingRunFiles(this.taskDir);
    await cleanTaskControlFiles(this.taskDir);
    await fs.promises.writeFile(path.join(this.taskDir, "input.txt"), text || "", "utf8");
    this.roundIndex = 0;
    this.spawnProcess();
    return this.waitForRound({ threadId, turnId: turnId || makeTurnId(threadId, this.roundIndex), roundIndex: this.roundIndex });
  }

  async sendNextTurn({ text = "", threadId = "", turnId = "" }) {
    if (!this.alive) {
      throw new Error("GenericAgent task process is not alive; start a fresh thread");
    }
    if (this.currentTurn) {
      throw new Error("GenericAgent turn is already running");
    }
    this.roundIndex = resolveNextOutputRoundIndex(this.taskDir);
    const resolvedTurnId = turnId || makeTurnId(threadId, this.roundIndex);
    await fs.promises.writeFile(path.join(this.taskDir, "reply.txt"), text || "", "utf8");
    return this.waitForRound({ threadId, turnId: resolvedTurnId, roundIndex: this.roundIndex });
  }

  spawnProcess() {
    const args = [this.resolveAgentMainPath(), "--task", this.taskArg || this.taskDir, "--llm_no", String(this.llmNo)];
    if (this.extraSystemFile) {
      args.push("--extra-system-file", this.extraSystemFile);
    }
    if (this.verbose) {
      args.push("--verbose");
    }
    this.process = spawn(this.pythonPath, args, {
      cwd: this.workspaceRoot || path.dirname(this.resolveAgentMainPath()),
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process.stdout.on("data", (data) => {
      const text = data.toString("utf8");
      if (text.trim()) {
        this.emit("log", { stream: "stdout", text });
      }
    });
    this.process.stderr.on("data", (data) => {
      const text = data.toString("utf8");
      if (text.trim()) {
        this.emit("log", { stream: "stderr", text });
      }
    });
    this.process.on("error", (error) => {
      this.emit("error", error);
      this.rejectCurrentTurn(error);
    });
    this.process.on("close", (code) => {
      this.emit("close", code);
      if (this.currentTurn && !this.currentTurn.completed) {
        this.rejectCurrentTurn(new Error(`GenericAgent process exited before turn completed (code ${code})`));
      }
    });
  }

  resolveAgentMainPath() {
    if (this.agentMainPath) {
      return this.agentMainPath;
    }
    const candidates = [
      path.resolve(__dirname, "..", "..", "..", "..", "..", "GenericAgent-main", "agentmain.py"),
      path.resolve(__dirname, "..", "..", "..", "..", "..", "..", "agentmain.py"),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
  }

  waitForRound({ threadId, turnId, roundIndex }) {
    return new Promise((resolve, reject) => {
      const outputPath = path.join(this.taskDir, outputFileName(roundIndex));
      const turn = {
        threadId,
        turnId,
        roundIndex,
        outputPath,
        completed: false,
        lastText: readExistingText(outputPath),
        pollTimer: null,
        timeoutTimer: null,
        deliveredVisibleText: "",
        deliveredSegmentTexts: [],
        deliveredPartIndex: 0,
        resolve,
        reject,
      };
      this.currentTurn = turn;
      setImmediate(() => {
        if (this.currentTurn === turn && !turn.completed) {
          this.emit("message", {
            type: "turn_started",
            threadId,
            turnId,
          });
        }
      });
      turn.pollTimer = setInterval(() => {
        this.pollTurnOutput(turn).catch((error) => this.rejectCurrentTurn(error));
      }, POLL_INTERVAL_MS);
      turn.timeoutTimer = setTimeout(() => {
        this.rejectCurrentTurn(new Error("GenericAgent turn timed out"));
      }, this.turnTimeoutMs);
      this.pollTurnOutput(turn).catch((error) => this.rejectCurrentTurn(error));
    });
  }

  async pollTurnOutput(turn) {
    const raw = await fs.promises.readFile(turn.outputPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") {
        return "";
      }
      throw error;
    });
    if (!raw || raw === turn.lastText) {
      return;
    }
    const cleanText = stripRoundEnd(raw);
    const visibleSegments = normalizeGenericAgentTurnOutputs(cleanText);
    const visibleText = joinVisibleSegments(visibleSegments);
    turn.lastText = raw;
    if (raw.includes(ROUND_END_MARKER)) {
      this.completeCurrentTurn(visibleText, { rawText: cleanText, visibleSegments });
      return;
    }
    this.emitStableReplyParts(turn, visibleSegments);
  }

  emitStableReplyParts(turn, visibleSegments, { force = false, final = false } = {}) {
    if (!turn || turn.completed || !Array.isArray(visibleSegments) || !visibleSegments.length) {
      return;
    }

    for (let index = 0; index < visibleSegments.length; index += 1) {
      const segmentText = trimOuterBlankLines(visibleSegments[index]);
      if (!segmentText) {
        continue;
      }
      const isLastSegment = index === visibleSegments.length - 1;
      const segmentHasMarkdown = hasStructuralMarkdown(segmentText);
      const segmentForce = force || !isLastSegment;
      if (segmentHasMarkdown && !segmentForce) {
        continue;
      }
      this.emitSegmentReplyPart(turn, index, segmentText, {
        force: segmentForce,
        final,
        preserveMarkdown: segmentHasMarkdown,
      });
    }
    turn.deliveredVisibleText = joinVisibleSegments(turn.deliveredSegmentTexts);
  }

  emitSegmentReplyPart(turn, segmentIndex, segmentText, { force = false, final = false, preserveMarkdown = false } = {}) {
    const base = turn.deliveredSegmentTexts[segmentIndex] || "";
    if (base && !segmentText.startsWith(base)) {
      return;
    }
    const suffix = segmentText.slice(base.length);
    const stableLength = force ? suffix.length : findLastStableBoundary(suffix);
    if (stableLength <= 0) {
      return;
    }
    const nextDeliveredText = segmentText.slice(0, base.length + stableLength);
    const partText = trimOuterBlankLines(nextDeliveredText.slice(base.length));
    turn.deliveredSegmentTexts[segmentIndex] = nextDeliveredText;
    if (!partText) {
      return;
    }
    turn.deliveredPartIndex += 1;
    const itemPrefix = final ? "ga-output-final" : "ga-output-part";
    this.emit("message", {
      type: "reply_completed",
      threadId: turn.threadId,
      turnId: turn.turnId,
      itemId: `${itemPrefix}-${turn.deliveredPartIndex}`,
      text: partText,
      preserveBlock: preserveMarkdown,
      preserveMarkdown,
    });
  }

  completeCurrentTurn(visibleText, { rawText = "", visibleSegments = [] } = {}) {
    const turn = this.currentTurn;
    if (!turn || turn.completed) {
      return;
    }
    this.clearTurnTimers(turn);
    this.currentTurn = null;
    const result = {
      threadId: turn.threadId,
      turnId: turn.turnId,
      roundIndex: turn.roundIndex,
      text: trimOuterBlankLines(visibleText),
      systemFinalText: trimOuterBlankLines(normalizeGenericAgentLastTurnOutput(rawText)),
    };
    this.emitStableReplyParts(turn, visibleSegments, { force: true, final: true });
    turn.completed = true;
    this.emit("message", {
      type: "turn_completed",
      ...result,
    });
    turn.resolve(result);
  }

  rejectCurrentTurn(error) {
    const turn = this.currentTurn;
    if (!turn || turn.completed) {
      return;
    }
    turn.completed = true;
    this.clearTurnTimers(turn);
    this.currentTurn = null;
    const message = error instanceof Error ? error.message : String(error || "GenericAgent turn failed");
    this.emit("message", {
      type: "turn_failed",
      threadId: turn.threadId,
      turnId: turn.turnId,
      text: message,
    });
    turn.reject(error instanceof Error ? error : new Error(message));
  }

  clearTurnTimers(turn) {
    if (turn.pollTimer) {
      clearInterval(turn.pollTimer);
    }
    if (turn.timeoutTimer) {
      clearTimeout(turn.timeoutTimer);
    }
  }

  async cancelTurn({ threadId = "", turnId = "" } = {}) {
    await fs.promises.writeFile(path.join(this.taskDir, "_stop"), "1", "utf8").catch(() => {});
    this.rejectCurrentTurn(new Error("GenericAgent turn cancelled"));
    return { threadId, turnId };
  }

  async close() {
    await fs.promises.writeFile(path.join(this.taskDir, "_stop"), "1", "utf8").catch(() => {});
    if (this.process && !this.process.killed) {
      this.process.kill("SIGTERM");
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 5_000).unref?.();
    }
  }
}

function outputFileName(roundIndex) {
  return roundIndex > 0 ? `output${roundIndex}.txt` : "output.txt";
}

function resolveNextOutputRoundIndex(taskDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(taskDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const indexes = entries
    .filter((entry) => entry.isFile())
    .map((entry) => outputRoundIndex(entry.name))
    .filter((index) => Number.isInteger(index) && index >= 0);
  if (!indexes.length) {
    return 0;
  }
  return Math.max(...indexes) + 1;
}

function outputRoundIndex(name) {
  const match = /^output(\d*)\.txt$/i.exec(String(name || ""));
  if (!match) {
    return -1;
  }
  return match[1] ? Number.parseInt(match[1], 10) : 0;
}

function makeTurnId(threadId, roundIndex) {
  return `${threadId || "ga"}-turn-${roundIndex + 1}`;
}

function stripRoundEnd(text) {
  return String(text || "").replace(ROUND_END_MARKER, "").trimEnd();
}

function hasStructuralMarkdown(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  if (!normalized.trim()) {
    return false;
  }
  if (/(^|\n)\s*(?:```|~~~)/.test(normalized)) {
    return true;
  }
  if (/(^|\n)\s{0,3}#{1,6}\s+\S/.test(normalized)) {
    return true;
  }
  if (/(^|\n)\s{0,3}(?:[-*+]\s+|\d+[.)]\s+)\S/.test(normalized)) {
    return true;
  }
  if (/(^|\n)\s{0,3}>\s+\S/.test(normalized)) {
    return true;
  }
  if (hasMarkdownTable(normalized)) {
    return true;
  }
  return hasInlineMarkdownFormatting(normalized);
}

function hasMarkdownTable(text) {
  const lines = String(text || "").split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!looksLikeTableHeader(lines[index])) {
      continue;
    }
    if (looksLikeTableSeparator(lines[index + 1])) {
      return true;
    }
  }
  return false;
}

function looksLikeTableHeader(line) {
  const trimmed = String(line || "").trim();
  return trimmed.includes("|") && trimmed.split("|").filter((cell) => cell.trim()).length >= 2;
}

function looksLikeTableSeparator(line) {
  const trimmed = String(line || "").trim();
  return /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed);
}

function hasInlineMarkdownFormatting(text) {
  return /(^|[^\*])\*\*(?=\S)(?:(?!\*\*).)*\S\*\*(?!\*)/s.test(text)
    || /(^|[^_])__(?=\S)(?:(?!__).)*\S__(?!_)/s.test(text);
}

function joinVisibleSegments(segments) {
  if (!Array.isArray(segments)) {
    return "";
  }
  return trimOuterBlankLines(segments
    .map((segment) => trimOuterBlankLines(segment))
    .filter(Boolean)
    .join("\n\n"));
}

function findLastStableBoundary(text) {
  const normalized = String(text || "");
  let boundary = 0;

  const paragraphRe = /\n\s*\n+/g;
  let match = paragraphRe.exec(normalized);
  while (match) {
    boundary = Math.max(boundary, match.index + match[0].length);
    match = paragraphRe.exec(normalized);
  }

  const listRe = /\n(?:(?:[-*])\s+|(?:\d+\.)\s+)/g;
  match = listRe.exec(normalized);
  while (match) {
    boundary = Math.max(boundary, match.index + 1);
    match = listRe.exec(normalized);
  }

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const isSentencePunctuation = /[\u3002\uff01\uff1f!?]/.test(char)
      || (char === "." && (index === normalized.length - 1 || /\s/.test(normalized[index + 1] || "")));
    if (!isSentencePunctuation) {
      continue;
    }
    let end = index + 1;
    while (end < normalized.length && /["'"'）)\]\u300d\u300f\u3011]/.test(normalized[end])) {
      end += 1;
    }
    while (end < normalized.length && /[\t \n]/.test(normalized[end])) {
      end += 1;
    }
    boundary = Math.max(boundary, end);
  }

  return boundary;
}

function trimOuterBlankLines(text) {
  return String(text || "")
    .replace(/^\s*\n+/g, "")
    .replace(/\n+\s*$/g, "");
}

async function cleanTaskControlFiles(taskDir) {
  const names = ["reply.txt", "_stop"];
  await Promise.all(names.map((name) => fs.promises.rm(path.join(taskDir, name), { force: true }).catch(() => {})));
}

async function archiveExistingRunFiles(taskDir) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(taskDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }

  const runFileNames = entries
    .filter((entry) => entry.isFile() && isRunFileName(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (!runFileNames.length) {
    return "";
  }

  const archiveDir = await createRunArchiveDir(taskDir);
  for (const name of runFileNames) {
    const source = path.join(taskDir, name);
    const target = path.join(archiveDir, name);
    await fs.promises.rename(source, target).catch(async (error) => {
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    });
  }
  return archiveDir;
}

function isRunFileName(name) {
  return name === "input.txt"
    || name === "reply.txt"
    || name === "_stop"
    || /^output\d*\.txt$/i.test(name);
}

async function createRunArchiveDir(taskDir) {
  const runsDir = path.join(taskDir, "runs");
  await fs.promises.mkdir(runsDir, { recursive: true });
  const base = formatShanghaiArchiveTimestamp(new Date());
  for (let index = 0; index < 100; index += 1) {
    const suffix = index ? `-${index}` : "";
    const candidate = path.join(runsDir, `${base}${suffix}`);
    try {
      await fs.promises.mkdir(candidate, { recursive: false });
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new Error("Unable to create GenericAgent run archive directory");
}

function formatShanghaiArchiveTimestamp(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});
  const millisecond = String(date.getMilliseconds()).padStart(3, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}-${parts.minute}-${parts.second}-${millisecond}+08-00`;
}

function readExistingText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function sanitizePathSegment(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "session";
}

function defaultTaskBaseDir(stateDir) {
  return path.join(
    stateDir || path.resolve(__dirname, "..", "..", "..", "..", "..", "cyberboss-data"),
    "genericagent-sessions",
  );
}

module.exports = {
  GenericAgentProcessClient,
  defaultTaskBaseDir,
  hasStructuralMarkdown,
  outputFileName,
  sanitizePathSegment,
};
