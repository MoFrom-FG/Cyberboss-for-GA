"use strict";

const fs = require("fs");
const path = require("path");

const TIME_ZONE = "Asia/Shanghai";
const DEFAULT_TIMELINE_INTERVAL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_DIARY_INTERVAL_MS = 6 * 60 * 60 * 1000;

const TIMELINE_SIGNAL_PATTERNS = [
  ["life", /吃|饭|早餐|早饭|午饭|中饭|晚饭|夜宵|kfc|肯德基|洗澡|洗头|洗漱|家务|收拾|购物|买了|办事/i],
  ["work", /工作|代码|开发|调试|仓库|实现|修复|开会|会议|写作|沟通|项目/i],
  ["study", /学习|看书|阅读|课程|上课|练习|复盘|考试|作业/i],
  ["exercise", /运动|散步|走走|锻炼|健身|拉伸|跑步/i],
  ["entertainment", /娱乐|游戏|王者|视频|看剧|电影|音乐|刷手机|刷视频|抖音|b站|bilibili/i],
  ["health", /健康|吃药|服药|药|头痛|头疼|疼|不舒服|医院|看病|门诊|adhd/i],
  ["social", /社交|聊天|通话|打电话|家人|朋友|消息/i],
  ["care", /照料|照顾|宠物|猫|家庭|自己|自我照顾/i],
  ["travel", /出门|回家|到家|离家|在路上|通勤|开车|地铁|公交|打车|出行/i],
  ["rest", /睡|睡觉|午睡|小睡|醒了|起床|躺|休息|放空|困/i],
];

const DIARY_SIGNAL_PATTERN = /累|困|开心|难过|焦虑|担心|生气|崩|重要|决定|确认|想法|状态|喜欢|讨厌|压力|舒服|不舒服|陪|夸|记得|记住/i;
const SLEEP_OR_WAKE_PATTERN = /睡|睡觉|午睡|小睡|醒了|起床|晚安|准备睡/i;

class WechatMaintenanceService {
  constructor({
    filePath,
    timelineIntervalMs = DEFAULT_TIMELINE_INTERVAL_MS,
    diaryIntervalMs = DEFAULT_DIARY_INTERVAL_MS,
  } = {}) {
    this.filePath = path.resolve(String(filePath || path.join("wechat-runtime", "maintenance-state.json")));
    this.timelineIntervalMs = positiveInt(timelineIntervalMs, DEFAULT_TIMELINE_INTERVAL_MS);
    this.diaryIntervalMs = positiveInt(diaryIntervalMs, DEFAULT_DIARY_INTERVAL_MS);
    this.state = { senders: {} };
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.state = normalizeState(parsed);
    } catch {
      this.state = { senders: {} };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getSenderState(senderId) {
    this.load();
    const normalizedSenderId = normalizeText(senderId);
    if (!normalizedSenderId) {
      return null;
    }
    const existing = this.state.senders[normalizedSenderId];
    const entry = normalizeSenderState(existing);
    this.state.senders[normalizedSenderId] = entry;
    return entry;
  }

  markUserMessage({ senderId = "", text = "", receivedAt = new Date() } = {}) {
    const normalizedSenderId = normalizeText(senderId);
    const normalizedText = normalizeText(text);
    if (!normalizedSenderId || !normalizedText) {
      return null;
    }
    const signals = detectMaintenanceSignals(normalizedText);
    if (!signals.timelineDirty && !signals.diaryDirty) {
      return null;
    }

    const entry = this.getSenderState(normalizedSenderId);
    const at = normalizeIsoTime(receivedAt) || new Date().toISOString();
    entry.lastTranscriptAt = at;
    entry.lastUserText = truncate(normalizedText, 240);
    entry.dirtySince = entry.dirtySince || at;
    entry.timelineDirty = entry.timelineDirty || signals.timelineDirty;
    entry.diaryDirty = entry.diaryDirty || signals.diaryDirty;
    entry.forceMaintenance = entry.forceMaintenance || signals.forceMaintenance;
    entry.signals = uniqueStrings([...(entry.signals || []), ...signals.signals]).slice(-20);
    this.save();
    return { senderId: normalizedSenderId, ...entry };
  }

  markTimelineWritten({ senderId = "", at = new Date() } = {}) {
    return this.markWritten({ senderId, field: "timeline", at });
  }

  markDiaryWritten({ senderId = "", at = new Date() } = {}) {
    return this.markWritten({ senderId, field: "diary", at });
  }

  markWritten({ senderId = "", field = "", at = new Date() } = {}) {
    const normalizedSenderId = normalizeText(senderId);
    if (!normalizedSenderId) {
      return null;
    }
    const entry = this.getSenderState(normalizedSenderId);
    const writtenAt = normalizeIsoTime(at) || new Date().toISOString();
    if (field === "timeline") {
      entry.lastTimelineAt = writtenAt;
      entry.timelineDirty = false;
    }
    if (field === "diary") {
      entry.lastDiaryAt = writtenAt;
      entry.diaryDirty = false;
    }
    if (!entry.timelineDirty && !entry.diaryDirty) {
      entry.dirtySince = "";
      entry.forceMaintenance = false;
      entry.signals = [];
      entry.lastUserText = "";
    }
    this.save();
    return { senderId: normalizedSenderId, ...entry };
  }

  buildCheckin({ senderId = "", userName = "User", now = new Date() } = {}) {
    const normalizedSenderId = normalizeText(senderId);
    const normalizedUserName = normalizeText(userName) || "User";
    if (!normalizedSenderId) {
      return {
        mode: "companion",
        text: `${normalizedUserName} comes to mind again.`,
      };
    }

    const entry = this.getSenderState(normalizedSenderId);
    const nowDate = normalizeDate(now);
    const nowIso = nowDate.toISOString();
    const crossDay = isCrossDay(entry.lastMaintenanceCheckinAt || entry.lastTranscriptAt || "", nowDate);
    const timelineDue = !!entry.timelineDirty && (
      entry.forceMaintenance
      || crossDay
      || isElapsed(entry.lastTimelineAt, nowDate, this.timelineIntervalMs)
    );
    const diaryDue = !!entry.diaryDirty && (
      entry.forceMaintenance
      || crossDay
      || isElapsed(entry.lastDiaryAt, nowDate, this.diaryIntervalMs)
    );

    if (!timelineDue && !diaryDue) {
      return {
        mode: "companion",
        text: `${normalizedUserName} comes to mind again.`,
      };
    }

    const reasons = [];
    if (timelineDue) {
      reasons.push("timeline");
    }
    if (diaryDue) {
      reasons.push("diary");
    }
    if (crossDay) {
      reasons.push("cross-day");
    }
    if (entry.forceMaintenance) {
      reasons.push("sleep-or-wake");
    }

    return {
      mode: "maintenance",
      text: [
        "WECHAT_MAINTENANCE_CHECKIN",
        `reason: ${uniqueStrings(reasons).join(", ")}`,
        `senderId: ${normalizedSenderId}`,
        `now: ${formatZonedDateTime(nowDate)} ${TIME_ZONE}; UTC ${nowIso}`,
        `dirtySince: ${entry.dirtySince || "(unknown)"}`,
        `life_event_signal: ${(entry.signals || []).join(", ") || "(unspecified)"}`,
        entry.lastUserText ? `latest user signal: ${entry.lastUserText}` : "",
      ].filter(Boolean).join("\n"),
      dueTimeline: timelineDue,
      dueDiary: diaryDue,
      signals: [...(entry.signals || [])],
    };
  }

  markMaintenanceQueued({ senderId = "", mode = "", at = new Date() } = {}) {
    const normalizedSenderId = normalizeText(senderId);
    if (!normalizedSenderId || normalizeText(mode) !== "maintenance") {
      return null;
    }
    const entry = this.getSenderState(normalizedSenderId);
    entry.lastMaintenanceCheckinAt = normalizeIsoTime(at) || new Date().toISOString();
    this.save();
    return { senderId: normalizedSenderId, ...entry };
  }
}

function detectMaintenanceSignals(text) {
  const normalized = normalizeText(text);
  const signals = [];
  for (const [name, pattern] of TIMELINE_SIGNAL_PATTERNS) {
    if (pattern.test(normalized)) {
      signals.push(name);
    }
  }
  const timelineDirty = signals.length > 0;
  const forceMaintenance = SLEEP_OR_WAKE_PATTERN.test(normalized);
  const diaryDirty = DIARY_SIGNAL_PATTERN.test(normalized)
    || forceMaintenance
    || (timelineDirty && /一整天|今天|下午|晚上|上午|凌晨|一直|很|太|终于|刚刚/i.test(normalized));
  return {
    timelineDirty,
    diaryDirty,
    forceMaintenance,
    signals: uniqueStrings(signals),
  };
}

function normalizeState(value) {
  const senders = {};
  for (const [senderId, entry] of Object.entries(value?.senders || {})) {
    const normalizedSenderId = normalizeText(senderId);
    if (!normalizedSenderId) {
      continue;
    }
    senders[normalizedSenderId] = normalizeSenderState(entry);
  }
  return { senders };
}

function normalizeSenderState(value) {
  return {
    dirtySince: normalizeIsoTime(value?.dirtySince),
    lastTimelineAt: normalizeIsoTime(value?.lastTimelineAt),
    lastDiaryAt: normalizeIsoTime(value?.lastDiaryAt),
    lastTranscriptAt: normalizeIsoTime(value?.lastTranscriptAt),
    lastMaintenanceCheckinAt: normalizeIsoTime(value?.lastMaintenanceCheckinAt),
    timelineDirty: !!value?.timelineDirty,
    diaryDirty: !!value?.diaryDirty,
    forceMaintenance: !!value?.forceMaintenance,
    signals: Array.isArray(value?.signals) ? uniqueStrings(value.signals.map(normalizeText).filter(Boolean)) : [],
    lastUserText: truncate(normalizeText(value?.lastUserText), 240),
  };
}

function isElapsed(value, now, intervalMs) {
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed)) {
    return true;
  }
  return now.getTime() - parsed >= intervalMs;
}

function isCrossDay(value, now) {
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed)) {
    return false;
  }
  return formatDate(new Date(parsed)) !== formatDate(now);
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatZonedDateTime(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
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

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizeText).filter(Boolean))];
}

function truncate(value, maxLength) {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  WechatMaintenanceService,
  detectMaintenanceSignals,
};
