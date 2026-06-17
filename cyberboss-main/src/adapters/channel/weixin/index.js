const crypto = require("crypto");
const { listWeixinAccounts, resolveSelectedAccount } = require("./account-store");
const { loadPersistedContextTokens, persistContextToken } = require("./context-token-store");
const { runLoginFlow } = require("./login");
const { getConfig, sendTyping } = require("./api");
const { getUpdates, sendText } = require("./api");
const { createInboundFilter } = require("./message-utils");
const { sendWeixinMediaFile } = require("./media-send");
const { loadSyncBuffer, saveSyncBuffer } = require("./sync-buffer-store");
const { loadWeixinConfig, saveWeixinConfig, DEFAULT_MIN_WEIXIN_CHUNK } = require("./config-store");

const LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_WEIXIN_CHUNK = 3800;
const SEND_MESSAGE_CHUNK_INTERVAL_MS = 350;
const WEIXIN_MAX_DELIVERY_MESSAGES = 10;
const WEIXIN_LIVE_DELIVERY_MESSAGES = 8;
const WEIXIN_DEFERRED_TAIL_NOTICE = "后面还有一段内容比较长，先暂存起来；等你下一条消息刷新微信 context_token 后，我会继续补发。";
const WEIXIN_MESSAGE_TYPE_BOT = 2;

function createWeixinChannelAdapter(config) {
  let selectedAccount = null;
  let contextTokenCache = null;
  const inboundFilter = createInboundFilter();
  let minWeixinChunk = loadWeixinConfig(config).minChunkChars;
  const deliveryBudgetByTarget = new Map();

  function ensureAccount() {
    if (!selectedAccount) {
      selectedAccount = resolveSelectedAccount(config);
      contextTokenCache = loadPersistedContextTokens(config, selectedAccount.accountId);
    }
    return selectedAccount;
  }

  function ensureContextTokenCache() {
    if (!contextTokenCache) {
      const account = ensureAccount();
      contextTokenCache = loadPersistedContextTokens(config, account.accountId);
    }
    return contextTokenCache;
  }

  function rememberContextToken(userId, contextToken) {
    const account = ensureAccount();
    const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
    const normalizedToken = typeof contextToken === "string" ? contextToken.trim() : "";
    if (!normalizedUserId || !normalizedToken) {
      return "";
    }
    const previousToken = ensureContextTokenCache()[normalizedUserId] || "";
    contextTokenCache = persistContextToken(config, account.accountId, normalizedUserId, normalizedToken);
    if (previousToken !== normalizedToken) {
      resetDeliveryBudget(normalizedUserId, normalizedToken);
    }
    return normalizedToken;
  }

  function resolveContextToken(userId, explicitToken = "") {
    const normalizedExplicitToken = typeof explicitToken === "string" ? explicitToken.trim() : "";
    if (normalizedExplicitToken) {
      return normalizedExplicitToken;
    }
    const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
    if (!normalizedUserId) {
      return "";
    }
    return ensureContextTokenCache()[normalizedUserId] || "";
  }

  function sendTextChunks({
    userId,
    text,
    contextToken = "",
    preserveBlock = false,
    preserveMarkdown = false,
    finalBurst = false,
  }) {
    const account = ensureAccount();
    const resolvedToken = resolveContextToken(userId, contextToken);
    if (!resolvedToken) {
      throw new Error(`Missing context_token. Cannot reply to user ${userId}.`);
    }
    const content = String(text || "");
    if (!content.trim()) {
      return Promise.resolve();
    }
    const textChunks = (preserveBlock || preserveMarkdown) ? null : chunkReplyTextForWeixin(content, minWeixinChunk);
    const rawSendChunks = preserveMarkdown
      ? chunkMarkdownForWeixin(content)
      : preserveBlock
      ? splitUtf8(compactPlainTextForWeixin(content) || "Completed.", MAX_WEIXIN_CHUNK)
      : textChunks?.length ? textChunks : ["Completed."];
    const budgetKey = buildDeliveryBudgetKey(userId, resolvedToken);
    const sentCount = getDeliveryBudgetSentCount(budgetKey);
    const plan = applyWeixinDeliveryBudget(rawSendChunks, sentCount, {
      preserveMarkdown,
      finalBurst,
      liveMessages: WEIXIN_LIVE_DELIVERY_MESSAGES,
      maxMessages: WEIXIN_MAX_DELIVERY_MESSAGES,
      maxChunkChars: MAX_WEIXIN_CHUNK,
    });
    const sentChunks = [];
    return plan.sendChunks.reduce((promise, chunk, index) => promise
      .then(() => {
        const compactChunk = preserveMarkdown
          ? String(chunk || "") || "Completed."
          : stripSentenceTailChineseFullStops(compactPlainTextForWeixin(chunk)) || "Completed.";
        return sendText({
          baseUrl: account.baseUrl,
          token: account.token,
          toUserId: userId,
          text: compactChunk,
          contextToken: resolvedToken,
          clientId: `cb-${crypto.randomUUID()}`,
        }).then(() => {
          sentChunks.push(compactChunk);
          incrementDeliveryBudget(budgetKey);
        });
      })
      .then(() => {
        if (index < plan.sendChunks.length - 1) {
          return sleep(SEND_MESSAGE_CHUNK_INTERVAL_MS);
        }
        return null;
      }), Promise.resolve())
      .then(() => ({
        deliveredText: joinWeixinChunks(sentChunks, preserveMarkdown),
        heldText: plan.heldText,
        deferredText: plan.deferredText,
        budgetLimited: Boolean(plan.heldText || plan.deferredText),
      }));
  }

  function getDeliveryBudgetSentCount(budgetKey) {
    const current = deliveryBudgetByTarget.get(budgetKey);
    return Number.isFinite(current?.sentCount) && current.sentCount > 0 ? current.sentCount : 0;
  }

  function incrementDeliveryBudget(budgetKey) {
    const current = getDeliveryBudgetSentCount(budgetKey);
    deliveryBudgetByTarget.set(budgetKey, {
      sentCount: current + 1,
      updatedAt: Date.now(),
    });
  }

  function resetDeliveryBudget(userId, contextToken) {
    const normalizedUserId = normalizeText(userId);
    const normalizedToken = normalizeText(contextToken);
    if (!normalizedUserId || !normalizedToken) {
      return;
    }
    const prefix = `${normalizedUserId}\u0000`;
    for (const key of deliveryBudgetByTarget.keys()) {
      if (key.startsWith(prefix)) {
        deliveryBudgetByTarget.delete(key);
      }
    }
    deliveryBudgetByTarget.set(buildDeliveryBudgetKey(normalizedUserId, normalizedToken), {
      sentCount: 0,
      updatedAt: Date.now(),
    });
  }

  return {
    describe() {
      return {
        id: "weixin",
        kind: "channel",
        stateDir: config.stateDir,
        baseUrl: config.weixinBaseUrl,
        accountsDir: config.accountsDir,
        syncBufferDir: config.syncBufferDir,
      };
    },
    async login() {
      await runLoginFlow(config);
    },
    printAccounts() {
      const accounts = listWeixinAccounts(config);
      if (!accounts.length) {
        console.log("No saved WeChat account found. Run `npm run login` first.");
        return;
      }
      console.log("Saved accounts:");
      for (const account of accounts) {
        console.log(`- ${account.accountId}`);
        console.log(`  userId: ${account.userId || "(unknown)"}`);
        console.log(`  baseUrl: ${account.baseUrl || config.weixinBaseUrl}`);
        console.log(`  savedAt: ${account.savedAt || "(unknown)"}`);
      }
    },
    resolveAccount() {
      return ensureAccount();
    },
    getKnownContextTokens() {
      return { ...ensureContextTokenCache() };
    },
    loadSyncBuffer() {
      const account = ensureAccount();
      return loadSyncBuffer(config, account.accountId);
    },
    saveSyncBuffer(buffer) {
      const account = ensureAccount();
      saveSyncBuffer(config, account.accountId, buffer);
    },
    rememberContextToken,
    async getUpdates({ syncBuffer = "", timeoutMs = LONG_POLL_TIMEOUT_MS } = {}) {
      const account = ensureAccount();
      const response = await getUpdates({
        baseUrl: account.baseUrl,
        token: account.token,
        getUpdatesBuf: syncBuffer,
        timeoutMs,
      });
      const newBuf = typeof response?.get_updates_buf === "string" ? response.get_updates_buf.trim() : "";
      if (newBuf && newBuf !== syncBuffer) {
        this.saveSyncBuffer(newBuf);
      }
      const messages = Array.isArray(response?.msgs) ? response.msgs : [];
      for (const message of messages) {
        if (Number(message?.message_type) === WEIXIN_MESSAGE_TYPE_BOT) {
          continue;
        }
        const userId = typeof message?.from_user_id === "string" ? message.from_user_id.trim() : "";
        const contextToken = typeof message?.context_token === "string" ? message.context_token.trim() : "";
        if (userId && contextToken) {
          rememberContextToken(userId, contextToken);
        }
      }
      return response;
    },
    normalizeIncomingMessage(message) {
      const account = ensureAccount();
      return inboundFilter.normalize(message, config, account.accountId);
    },
    async sendText({ userId, text, contextToken = "", preserveBlock = false, preserveMarkdown = false, finalBurst = false }) {
      return sendTextChunks({ userId, text, contextToken, preserveBlock, preserveMarkdown, finalBurst });
    },
    async sendTyping({ userId, status = 1, contextToken = "" }) {
      const account = ensureAccount();
      const resolvedToken = resolveContextToken(userId, contextToken);
      if (!resolvedToken) {
        return;
      }
      const configResponse = await getConfig({
        baseUrl: account.baseUrl,
        token: account.token,
        ilinkUserId: userId,
        contextToken: resolvedToken,
      }).catch(() => null);
      const typingTicket = typeof configResponse?.typing_ticket === "string"
        ? configResponse.typing_ticket.trim()
        : "";
      if (!typingTicket) {
        return;
      }
      await sendTyping({
        baseUrl: account.baseUrl,
        token: account.token,
        body: {
          ilink_user_id: userId,
          typing_ticket: typingTicket,
          status,
        },
      });
    },
    async sendFile({ userId, filePath, contextToken = "" }) {
      const account = ensureAccount();
      const resolvedToken = resolveContextToken(userId, contextToken);
      if (!resolvedToken) {
        throw new Error(`Missing context_token. Cannot send a file to user ${userId}.`);
      }
      return sendWeixinMediaFile({
        filePath,
        to: userId,
        contextToken: resolvedToken,
        baseUrl: account.baseUrl,
        token: account.token,
        cdnBaseUrl: config.weixinCdnBaseUrl,
      });
    },
    setMinChunkChars(value) {
      const parsed = Number.parseInt(String(value), 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= MAX_WEIXIN_CHUNK) {
        minWeixinChunk = parsed;
        saveWeixinConfig(config, { minChunkChars: minWeixinChunk });
      }
      return minWeixinChunk;
    },
    getMinChunkChars() {
      return minWeixinChunk;
    },
  };
}

function splitUtf8(text, maxRunes) {
  const runes = Array.from(String(text || ""));
  if (!runes.length || runes.length <= maxRunes) {
    return [String(text || "")];
  }
  const chunks = [];
  while (runes.length) {
    chunks.push(runes.splice(0, maxRunes).join(""));
  }
  return chunks;
}

function chunkMarkdownForWeixin(text) {
  const normalized = trimOuterBlankLines(String(text || "").replace(/\r\n/g, "\n")) || "Completed.";
  return splitUtf8(normalized, MAX_WEIXIN_CHUNK);
}

function compactPlainTextForWeixin(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  return trimOuterBlankLines(normalized.replace(/\n\s*\n+/g, "\n"));
}

function stripSentenceTailChineseFullStops(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.replace(/。+(?=(?:\s*["'"'）)\]\u300d\u300f\u3011])*\s*$)/u, ""))
    .join("\n");
}

function chunkReplyText(text, limit = 3500) {
  const normalized = trimOuterBlankLines(String(text || "").replace(/\r\n/g, "\n"));
  if (!normalized.trim()) {
    return [];
  }

  const chunks = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit);
    const splitIndex = Math.max(
      candidate.lastIndexOf("\n\n"),
      candidate.lastIndexOf("\n"),
      candidate.lastIndexOf("。"),
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf(" ")
    );
    const cut = splitIndex > limit * 0.4 ? splitIndex + (candidate[splitIndex] === "\n" ? 0 : 1) : limit;
    const chunk = trimOuterBlankLines(remaining.slice(0, cut));
    if (chunk.trim()) {
      chunks.push(chunk);
    }
    remaining = trimOuterBlankLines(remaining.slice(cut));
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks.filter(Boolean);
}

function chunkReplyTextForWeixin(text, minChunk = DEFAULT_MIN_WEIXIN_CHUNK) {
  const normalized = trimOuterBlankLines(String(text || "").replace(/\r\n/g, "\n"));
  if (!normalized.trim()) {
    return [];
  }

  const boundaries = collectStreamingBoundaries(normalized);
  if (!boundaries.length) {
    return chunkReplyText(normalized, MAX_WEIXIN_CHUNK);
  }

  const units = [];
  let start = 0;
  for (const boundary of boundaries) {
    if (boundary <= start) {
      continue;
    }
    const unit = trimOuterBlankLines(normalized.slice(start, boundary));
    if (unit) {
      units.push(unit);
    }
    start = boundary;
  }

  const tail = trimOuterBlankLines(normalized.slice(start));
  if (tail) {
    units.push(tail);
  }

  if (!units.length) {
    return chunkReplyText(normalized, MAX_WEIXIN_CHUNK);
  }

  const chunks = [];
  for (const unit of units) {
    if (unit.length <= MAX_WEIXIN_CHUNK) {
      chunks.push(unit);
      continue;
    }
    chunks.push(...chunkReplyText(unit, MAX_WEIXIN_CHUNK));
  }
  return mergeShortChunks(chunks.filter(Boolean), MAX_WEIXIN_CHUNK, minChunk);
}

function mergeShortChunks(chunks, maxLength, minLength) {
  if (!chunks.length) {
    return chunks;
  }
  const merged = [];
  let buffer = chunks[0];
  for (let index = 1; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const isShort = buffer.length < minLength && chunk.length < minLength;
    const joined = `${buffer}\n${chunk}`;
    if (isShort && joined.length <= maxLength) {
      buffer = joined;
    } else {
      merged.push(buffer);
      buffer = chunk;
    }
  }
  merged.push(buffer);
  return merged;
}

function packChunksForWeixinDelivery(chunks, maxMessages = 10, maxChunkChars = 3800) {
  const normalizedChunks = Array.isArray(chunks)
    ? chunks.map((chunk) => compactPlainTextForWeixin(chunk)).filter(Boolean)
    : [];
  if (!normalizedChunks.length || normalizedChunks.length <= maxMessages) {
    return normalizedChunks;
  }

  const packed = normalizedChunks.slice(0, Math.max(0, maxMessages - 1));
  const tailChunks = normalizedChunks.slice(Math.max(0, maxMessages - 1));
  if (!tailChunks.length) {
    return packed;
  }

  const tailText = compactPlainTextForWeixin(tailChunks.join("\n")) || "Completed.";
  if (tailText.length <= maxChunkChars) {
    packed.push(tailText);
    return packed;
  }

  const tailHardChunks = splitUtf8(tailText, maxChunkChars);
  if (tailHardChunks.length === 1) {
    packed.push(tailHardChunks[0]);
    return packed;
  }

  const preserveCount = Math.max(0, maxMessages - tailHardChunks.length);
  const preserved = normalizedChunks.slice(0, preserveCount);
  const rebundledTail = normalizedChunks.slice(preserveCount);
  const groupedTail = [];
  let current = "";
  for (const chunk of rebundledTail) {
    const joined = current ? `${current}\n${chunk}` : chunk;
    if (current && joined.length > maxChunkChars) {
      groupedTail.push(current);
      current = chunk;
      continue;
    }
    current = joined;
  }
  if (current) {
    groupedTail.push(current);
  }

  return preserved.concat(groupedTail.map((item) => compactPlainTextForWeixin(item) || "Completed.")).slice(0, maxMessages);
}

function applyWeixinDeliveryBudget(chunks, sentCount = 0, options = {}) {
  const preserveMarkdown = Boolean(options.preserveMarkdown);
  const finalBurst = Boolean(options.finalBurst);
  const maxMessages = normalizePositiveInteger(options.maxMessages, WEIXIN_MAX_DELIVERY_MESSAGES);
  const liveMessages = normalizePositiveInteger(options.liveMessages, WEIXIN_LIVE_DELIVERY_MESSAGES);
  const maxChunkChars = normalizePositiveInteger(options.maxChunkChars, MAX_WEIXIN_CHUNK);
  const normalizedChunks = normalizeWeixinDeliveryChunks(chunks, preserveMarkdown);
  if (!normalizedChunks.length) {
    return { sendChunks: [], heldText: "", deferredText: "" };
  }

  const normalizedSentCount = Math.max(0, Number.isFinite(Number(sentCount)) ? Number(sentCount) : 0);
  if (finalBurst) {
    return packWeixinFinalBurst(normalizedChunks, normalizedSentCount, {
      preserveMarkdown,
      maxMessages,
      maxChunkChars,
    });
  }

  const liveRemaining = Math.max(0, liveMessages - normalizedSentCount);
  if (normalizedChunks.length <= liveRemaining) {
    return {
      sendChunks: normalizedChunks,
      heldText: "",
      deferredText: "",
    };
  }

  const sendChunks = normalizedChunks.slice(0, liveRemaining);
  const heldText = joinWeixinChunks(normalizedChunks.slice(liveRemaining), preserveMarkdown);
  return {
    sendChunks,
    heldText,
    deferredText: "",
  };
}

function packWeixinFinalBurst(chunks, sentCount, { preserveMarkdown, maxMessages, maxChunkChars }) {
  const remainingMessages = Math.max(0, maxMessages - sentCount);
  if (remainingMessages <= 0) {
    return {
      sendChunks: [],
      heldText: "",
      deferredText: joinWeixinChunks(chunks, preserveMarkdown),
    };
  }

  const sendChunks = [];
  let current = "";
  let deferredStartIndex = -1;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const normalizedChunk = preserveMarkdown ? String(chunk || "").trim() : compactPlainTextForWeixin(chunk);
    if (!normalizedChunk) {
      continue;
    }

    if (normalizedChunk.length > maxChunkChars) {
      if (current) {
        const pushed = pushWeixinFinalBurstChunk(sendChunks, current, remainingMessages, maxChunkChars);
        if (!pushed) {
          deferredStartIndex = index - 1;
          break;
        }
        current = "";
      }
      const hardChunks = splitUtf8(normalizedChunk, maxChunkChars);
      for (const hardChunk of hardChunks) {
        const pushed = pushWeixinFinalBurstChunk(sendChunks, hardChunk, remainingMessages, maxChunkChars);
        if (!pushed) {
          deferredStartIndex = index;
          break;
        }
      }
      if (deferredStartIndex >= 0) {
        break;
      }
      current = "";
      continue;
    }

    const joined = current ? `${current}${preserveMarkdown ? "\n\n" : "\n"}${normalizedChunk}` : normalizedChunk;
    if (joined.length <= maxChunkChars) {
      current = joined;
      continue;
    }

    if (current) {
      const pushed = pushWeixinFinalBurstChunk(sendChunks, current, remainingMessages, maxChunkChars);
      if (!pushed) {
        deferredStartIndex = index - 1;
        break;
      }
    }
    current = normalizedChunk;
  }

  if (deferredStartIndex < 0 && current) {
    const pushed = pushWeixinFinalBurstChunk(sendChunks, current, remainingMessages, maxChunkChars);
    if (!pushed) {
      deferredStartIndex = Math.max(0, chunks.length - 1);
    }
  }

  if (deferredStartIndex < 0) {
    return { sendChunks, heldText: "", deferredText: "" };
  }

  return {
    sendChunks: sendChunks.length ? sendChunks : [WEIXIN_DEFERRED_TAIL_NOTICE],
    heldText: "",
    deferredText: joinWeixinChunks(chunks.slice(deferredStartIndex), preserveMarkdown),
  };
}

function pushWeixinFinalBurstChunk(sendChunks, chunk, remainingMessages, maxChunkChars) {
  const normalized = trimOuterBlankLines(String(chunk || ""));
  if (!normalized) {
    return true;
  }
  if (sendChunks.length >= remainingMessages) {
    return false;
  }
  sendChunks.push(normalized.slice(0, maxChunkChars));
  return true;
}

function normalizeWeixinDeliveryChunks(chunks, preserveMarkdown = false) {
  if (!Array.isArray(chunks)) {
    return [];
  }
  return chunks
    .map((chunk) => preserveMarkdown ? String(chunk || "").trim() : compactPlainTextForWeixin(chunk))
    .filter(Boolean);
}

function joinWeixinChunks(chunks, preserveMarkdown = false) {
  const normalized = normalizeWeixinDeliveryChunks(chunks, preserveMarkdown);
  return normalized.join(preserveMarkdown ? "\n\n" : "\n");
}

function buildDeliveryBudgetKey(userId, contextToken) {
  return `${normalizeText(userId)}\u0000${normalizeText(contextToken)}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return parsed;
  }
  return fallback;
}

function collectStreamingBoundaries(text) {
  const boundaries = new Set();

  const regex = /\n\s*\n+/g;
  let match = regex.exec(text);
  while (match) {
    boundaries.add(match.index + match[0].length);
    match = regex.exec(text);
  }

  const listRegex = /\n(?:(?:[-*])\s+|(?:\d+\.)\s+)/g;
  match = listRegex.exec(text);
  while (match) {
    boundaries.add(match.index + 1);
    match = listRegex.exec(text);
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!/[\u3002\uff01\uff1f!?]/.test(char)) {
      continue;
    }

    let end = index + 1;
    while (end < text.length && /["'"'）)\]\u300d\u300f\u3011]/.test(text[end])) {
      end += 1;
    }
    while (end < text.length && /[\t \n]/.test(text[end])) {
      end += 1;
    }
    boundaries.add(end);
  }

  return Array.from(boundaries).sort((left, right) => left - right);
}

function trimOuterBlankLines(text) {
  return String(text || "")
    .replace(/^\s*\n+/g, "")
    .replace(/\n+\s*$/g, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  createWeixinChannelAdapter,
  splitUtf8,
  chunkMarkdownForWeixin,
  compactPlainTextForWeixin,
  stripSentenceTailChineseFullStops,
  chunkReplyText,
  chunkReplyTextForWeixin,
  mergeShortChunks,
  packChunksForWeixinDelivery,
  applyWeixinDeliveryBudget,
  joinWeixinChunks,
  collectStreamingBoundaries,
  trimOuterBlankLines,
};
