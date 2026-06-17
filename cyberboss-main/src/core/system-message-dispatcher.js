class SystemMessageDispatcher {
  constructor({ queueStore, config, accountId }) {
    this.queueStore = queueStore;
    this.config = config;
    this.accountId = accountId;
  }

  hasPending() {
    return this.queueStore.hasPendingForAccount(this.accountId);
  }

  drainPending() {
    return this.queueStore.drainForAccount(this.accountId);
  }

  requeue(message) {
    return this.queueStore.enqueue(message);
  }

  resolveWorkspaceRoot(message) {
    return normalizeText(message?.workspaceRoot) || normalizeText(this.config.workspaceRoot);
  }

  buildPreparedMessage(message, contextToken = "") {
    return {
      provider: "system",
      workspaceId: this.config.workspaceId,
      accountId: this.accountId,
      chatId: message.senderId,
      threadKey: `system:${message.senderId}`,
      senderId: message.senderId,
      messageId: message.id,
      text: buildSystemInboundText(message?.text, message?.createdAt, message?.mode),
      attachments: [],
      command: "message",
      contextToken,
      receivedAt: normalizeIsoTime(message?.createdAt) || new Date().toISOString(),
      workspaceRoot: this.resolveWorkspaceRoot(message),
    };
  }
}

const SYSTEM_MESSAGE_TIME_ZONE = "Asia/Shanghai";

function buildSystemInboundText(text, createdAt = "", mode = "") {
  const body = normalizeText(text);
  const localTime = formatSystemLocalTime(createdAt);
  const normalizedMode = normalizeText(mode).toLowerCase() || inferSystemMode(body);
  const sections = [
    ...(localTime ? [`[${localTime}]`, ""] : []),
    ...buildSystemModeInstructions(normalizedMode),
  ];
  if (body) {
    sections.push("", "Trigger:", body);
  }
  return sections.join("\n").trim();
}

function buildSystemModeInstructions(mode) {
  if (mode === "maintenance") {
    return [
      "SYSTEM MAINTENANCE MODE: internal Cyberboss WeChat record upkeep, not user chat.",
      "Use the lightweight WeChat record SOP. Do not use media/token/screenshot troubleshooting SOPs in this turn.",
      "First update timeline for concrete life_event_signal time blocks when enough information is available.",
      "Then update diary only for meaningful state, emotion, decisions, relationship context, or day-level continuity.",
      "After any tool calls, choose silent or one short natural WeChat message. Do not send only a casual check-in if record maintenance is stale.",
      "Return exactly one JSON object after any tool calls:",
      "{\"action\":\"silent\"}",
      "{\"action\":\"send_message\",\"message\":\"<one short natural WeChat message>\"}",
      "No reasoning. No text outside the JSON.",
    ];
  }
  if (mode === "companion") {
    return [
      "SYSTEM COMPANION CHECKIN MODE: internal Cyberboss WeChat companionship trigger, not user chat.",
      "You may send one short natural check-in only if it is helpful right now; use silent if interruption would not help.",
      "Do not perform media/token/screenshot troubleshooting in this mode.",
      "Return exactly one JSON object after any tool calls:",
      "{\"action\":\"silent\"}",
      "{\"action\":\"send_message\",\"message\":\"<one short natural WeChat message>\"}",
      "No reasoning. No text outside the JSON.",
    ];
  }
  if (mode === "subagent_result") {
    return [
      "SYSTEM SUBAGENT RESULT MODE: internal Cyberboss subagent completion trigger, not user chat.",
      "Read the referenced subagent output file, inspect any referenced task artifacts when needed, and prepare the user-facing result.",
      "If an output.md or final artifact is missing, create it in the referenced subagent task directory before replying.",
      "You may use the Today Task push tool or SOP when the original user asked for a push, but do not expose tool logs or internal paths in the final chat message.",
      "After any tool calls, return exactly one JSON object:",
      "{\"action\":\"silent\"}",
      "{\"action\":\"send_message\",\"message\":\"<concise natural WeChat message with the result>\"}",
      "No reasoning. No text outside the JSON.",
    ];
  }
  return [
    "SYSTEM ACTION MODE: internal trigger, not user chat.",
    "Do any timeline/diary/reminder/whereabouts work in this turn.",
    "If you act, end with send_message that briefly and naturally reflects what you did or what changed; use silent only if you do nothing.",
    "Return exactly one JSON object after any tool calls:",
    "{\"action\":\"silent\"}",
    "{\"action\":\"send_message\",\"message\":\"<one short natural WeChat message>\"}",
    "No reasoning. No text outside the JSON.",
  ];
}

function inferSystemMode(text) {
  const normalized = normalizeText(text);
  if (/^WECHAT_MAINTENANCE_CHECKIN\b/i.test(normalized)) {
    return "maintenance";
  }
  if (/^WECHAT_COMPANION_CHECKIN\b/i.test(normalized)) {
    return "companion";
  }
  if (/^📋\s*Subagent\b/i.test(normalized) || /^Subagent\b/i.test(normalized)) {
    return "subagent_result";
  }
  return "";
}

function formatSystemLocalTime(value) {
  const normalized = normalizeIsoTime(value);
  if (!normalized) {
    return "";
  }
  return `${formatZonedDateTime(normalized)} ${SYSTEM_MESSAGE_TIME_ZONE}; UTC ${normalized}`;
}

function formatZonedDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SYSTEM_MESSAGE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== "literal") {
      result[part.type] = part.value;
    }
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { SystemMessageDispatcher, buildSystemInboundText };
