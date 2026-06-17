const crypto = require("crypto");

const DEFAULT_PUSH_URL = "https://hiboard-claw-drcn.ai.dbankcloud.cn/distribution/message/cloud/claw/msg/upload";
const DEFAULT_TIMEOUT_MS = 30_000;

class TodayTaskService {
  constructor({ config, fetchImpl, now } = {}) {
    this.config = config || {};
    this.fetchImpl = fetchImpl || global.fetch;
    this.now = typeof now === "function" ? now : () => new Date();
  }

  isConfigured() {
    return Boolean(normalizeText(this.config.todayTaskAuthCode) && normalizeText(this.config.todayTaskPushUrl));
  }

  buildPayload(args = {}, context = {}) {
    const now = this.now();
    const timestamp = Math.floor(now.getTime() / 1000);
    const taskId = normalizeText(args.taskId) || `cyberboss-${now.getTime()}-${crypto.randomUUID()}`;
    const title = normalizeText(args.title);
    const result = normalizeText(args.result);
    const content = normalizeText(args.content);
    if (!title) {
      throw new Error("today task title is required.");
    }
    if (!result) {
      throw new Error("today task result is required.");
    }

    return {
      data: {
        authCode: normalizeText(this.config.todayTaskAuthCode),
        msgContent: [{
          msgId: taskId,
          scheduleTaskId: `cyberboss_${timestamp}`,
          scheduleTaskName: title,
          summary: title,
          result,
          content,
          source: "CyberBoss",
          taskFinishTime: timestamp,
          metadata: {
            runtimeId: normalizeText(context.runtimeId),
            workspaceRoot: normalizeText(context.workspaceRoot),
            threadId: normalizeText(context.threadId),
            senderId: normalizeText(context.senderId),
          },
        }],
      },
    };
  }

  async push(args = {}, context = {}) {
    if (!this.isConfigured()) {
      throw new Error("Today Task push is not configured. Set CYBERBOSS_TODAY_TASK_AUTH_CODE.");
    }
    if (typeof this.fetchImpl !== "function") {
      throw new Error("Today Task push requires a fetch implementation.");
    }

    const payload = this.buildPayload(args, context);
    const timeoutMs = resolveTimeoutMs(this.config.todayTaskTimeoutMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let responseBody = null;
    try {
      const traceId = crypto.randomUUID();
      response = await this.fetchImpl(normalizeText(this.config.todayTaskPushUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "user-agent": "CyberBoss/0.1",
          "x-auth-code": payload.data.authCode,
          "x-trace-id": traceId,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      responseBody = await readResponseBody(response);
    } finally {
      clearTimeout(timeout);
    }

    if (!response || !response.ok) {
      const status = response ? `${response.status} ${response.statusText || ""}`.trim() : "no response";
      throw new Error(`Today Task push failed: ${status}${formatResponseBody(responseBody)}`);
    }
    if (responseBody && typeof responseBody === "object" && !isSuccessCode(responseBody.code)) {
      throw new Error(`Today Task push failed: ${responseBody.code || "unknown"} ${responseBody.desc || ""}`.trim());
    }

    return {
      ok: true,
      taskId: payload.data.msgContent[0].msgId,
      status: response.status,
      response: responseBody,
      payload: redactPayload(payload),
    };
  }
}

async function readResponseBody(response) {
  if (!response) {
    return null;
  }
  const contentType = typeof response.headers?.get === "function"
    ? normalizeText(response.headers.get("content-type")).toLowerCase()
    : "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  try {
    const text = await response.text();
    return text || null;
  } catch {
    return null;
  }
}

function formatResponseBody(body) {
  if (body == null || body === "") {
    return "";
  }
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return `: ${text.slice(0, 500)}`;
}

function resolveTimeoutMs(value) {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function redactPayload(payload) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : {};
  return {
    ...payload,
    data: {
      ...data,
      authCode: data.authCode ? "[redacted]" : "",
    },
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isSuccessCode(code) {
  return code === undefined || code === null || code === "" || code === 0 || code === "0" || code === "0000000000";
}

module.exports = {
  DEFAULT_PUSH_URL,
  TodayTaskService,
};
