const { sanitizeProtocolLeakText } = require("../adapters/runtime/shared/protocol-leak-monitor");

const CURRENT_REPLY_HEADER = "===== 本轮模型回复 =====";

class StreamDelivery {
  constructor({
    channelAdapter,
    sessionStore,
    onDeferredSystemReply,
    systemReplyRetryScheduleMs,
    sameTokenRetryDelayMs,
    deliverIntermediateReplies = true,
  }) {
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.onDeferredSystemReply = typeof onDeferredSystemReply === "function" ? onDeferredSystemReply : null;
    this.shouldDeliverIntermediateReplies = typeof deliverIntermediateReplies === "function"
      ? deliverIntermediateReplies
      : () => Boolean(deliverIntermediateReplies);
    this.systemReplyRetryScheduleMs = Array.isArray(systemReplyRetryScheduleMs) && systemReplyRetryScheduleMs.length
      ? systemReplyRetryScheduleMs.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0)
      : [1_500, 2_500, 4_000, 6_000];
    this.sameTokenRetryDelayMs = Number.isFinite(sameTokenRetryDelayMs) && sameTokenRetryDelayMs >= 0
      ? sameTokenRetryDelayMs
      : 800;
    this.replyTargetByBindingKey = new Map();
    this.replyTargetByTurnKey = new Map();
    this.replyTargetQueueByThreadId = new Map();
    this.deferredReplyPrefixByBindingKey = new Map();
    this.stateByRunKey = new Map();
    this.runSequence = 0;
  }

  setReplyTarget(bindingKey, target) {
    if (!bindingKey || !target?.userId || !target?.contextToken) {
      return;
    }
    this.replyTargetByBindingKey.set(bindingKey, {
      userId: String(target.userId).trim(),
      contextToken: String(target.contextToken).trim(),
      provider: normalizeText(target.provider),
    });
  }

  queueReplyTargetForThread(threadId, target) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTarget = normalizeReplyTarget(target);
    if (!normalizedThreadId || !normalizedTarget) {
      return;
    }
    const queue = this.replyTargetQueueByThreadId.get(normalizedThreadId) || [];
    queue.push(normalizedTarget);
    this.replyTargetQueueByThreadId.set(normalizedThreadId, queue);
    this.bindQueuedReplyTargetsToActiveThreadRuns(normalizedThreadId);
  }

  bindReplyTargetForTurn({ threadId = "", turnId = "", target = null } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    const normalizedTarget = normalizeReplyTarget(target);
    if (!normalizedThreadId || !normalizedTurnId || !normalizedTarget) {
      this.queueReplyTargetForThread(normalizedThreadId, target);
      return;
    }

    const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
    this.replyTargetByTurnKey.set(runKey, normalizedTarget);
    const activeState = this.stateByRunKey.get(runKey);
    if (activeState) {
      this.applyThreadReplyTarget(activeState, normalizedTarget);
    }
  }

  setDeferredReplyPrefix(bindingKey, text) {
    const normalizedBindingKey = normalizeText(bindingKey);
    const normalizedText = trimOuterBlankLines(normalizeLineEndings(text));
    if (!normalizedBindingKey || !normalizedText) {
      return;
    }
    this.deferredReplyPrefixByBindingKey.set(normalizedBindingKey, normalizedText);
  }

  resolveReplyTargetForRun({ threadId = "", turnId = "" } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    if (!normalizedThreadId) {
      return null;
    }

    const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
    const state = this.stateByRunKey.get(runKey);
    if (state?.replyTarget) {
      return normalizeReplyTarget(state.replyTarget);
    }

    const exactTurnTarget = this.replyTargetByTurnKey.get(runKey);
    if (exactTurnTarget) {
      return normalizeReplyTarget(exactTurnTarget);
    }

    const queuedTargets = this.replyTargetQueueByThreadId.get(normalizedThreadId);
    if (Array.isArray(queuedTargets) && queuedTargets.length > 0) {
      return normalizeReplyTarget(queuedTargets[0]);
    }

    const linked = this.sessionStore.findBindingForThreadId(normalizedThreadId);
    if (!linked?.bindingKey) {
      return null;
    }
    return normalizeReplyTarget(this.replyTargetByBindingKey.get(linked.bindingKey));
  }

  async handleRuntimeEvent(event) {
    const threadId = normalizeText(event?.payload?.threadId);
    const turnId = normalizeText(event?.payload?.turnId);
    if (!threadId) {
      return;
    }

    switch (event.type) {
      case "runtime.turn.started": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        this.attachReplyTarget(state);
        return;
      }
      case "runtime.reply.delta": {
        if (!this.shouldDeliverIntermediateReplies({ threadId, turnId })) {
          return;
        }
        const state = this.ensureRunState(threadId, turnId);
        this.upsertItem(state, {
          itemId: normalizeText(event.payload.itemId) || `item-${state.itemOrder.length + 1}`,
          text: normalizeLineEndings(event.payload.text),
          completed: false,
        });
        return;
      }
      case "runtime.reply.completed": {
        if (!this.shouldDeliverIntermediateReplies({ threadId, turnId })) {
          return;
        }
        const state = this.ensureRunState(threadId, turnId);
        this.upsertItem(state, {
          itemId: normalizeText(event.payload.itemId) || `item-${state.itemOrder.length + 1}`,
          text: normalizeLineEndings(event.payload.text),
          completed: true,
          preserveBlock: Boolean(event.payload.preserveBlock),
          preserveMarkdown: Boolean(event.payload.preserveMarkdown),
        });
        await this.flush(state, { force: false });
        return;
      }
      case "runtime.turn.completed": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        state.systemFinalText = trimOuterBlankLines(normalizeLineEndings(event.payload.systemFinalText || ""));
        if (this.shouldDeliverIntermediateReplies({ threadId, turnId })) {
          this.captureTurnCompletionText(state, event.payload.text);
        } else {
          this.captureTurnCompletionText(state, state.systemFinalText || event.payload.text, {
            preserveMarkdown: true,
            replaceItems: true,
          });
        }
        await this.flush(state, { force: true });
        this.disposeRunState(state.runKey);
        return;
      }
      case "runtime.turn.failed":
        this.disposeRunState(buildRunKey(threadId, turnId));
        return;
      default:
        return;
    }
  }

  ensureRunState(threadId, turnId = "") {
    const runKey = buildRunKey(threadId, turnId);
    const existing = this.stateByRunKey.get(runKey);
    if (existing) {
      return existing;
    }

    const created = {
      runKey,
      threadId,
      bindingKey: "",
      replyTarget: null,
      deferredReplyPrefix: "",
      turnId: normalizeText(turnId),
      itemOrder: [],
      items: new Map(),
      sentItemIds: new Set(),
      sentReplyText: "",
      heldReplyText: "",
      heldReplyKind: "plain_reply",
      heldReplyPreserveMarkdown: false,
      sendChain: Promise.resolve(),
      flushPromise: null,
      sequence: this.runSequence += 1,
      threadReplyTargetAttached: false,
      systemFinalText: "",
    };
    this.stateByRunKey.set(runKey, created);
    this.attachReplyTarget(created);
    return created;
  }

  attachReplyTarget(state) {
    if (!state.threadReplyTargetAttached && state.turnId) {
      const exactTurnTarget = this.replyTargetByTurnKey.get(buildRunKey(state.threadId, state.turnId)) || null;
      if (exactTurnTarget) {
        this.applyThreadReplyTarget(state, exactTurnTarget);
      }
    }
    if (!state.threadReplyTargetAttached) {
      const threadTarget = this.consumeQueuedReplyTarget(state.threadId);
      if (threadTarget) {
        this.applyThreadReplyTarget(state, threadTarget);
      }
    }
    const linked = this.sessionStore.findBindingForThreadId(state.threadId);
    if (!linked?.bindingKey) {
      return;
    }
    state.bindingKey = linked.bindingKey;
    if (!state.replyTarget) {
      const target = this.replyTargetByBindingKey.get(linked.bindingKey);
      state.replyTarget = target;
    }
    if (!state.deferredReplyPrefix) {
      const prefix = this.deferredReplyPrefixByBindingKey.get(linked.bindingKey) || "";
      if (prefix) {
        state.deferredReplyPrefix = prefix;
        this.deferredReplyPrefixByBindingKey.delete(linked.bindingKey);
      }
    }
  }

  captureTurnCompletionText(state, text, { preserveMarkdown = false, replaceItems = false } = {}) {
    const normalized = trimOuterBlankLines(normalizeLineEndings(text));
    if (!normalized) {
      return;
    }
    if (replaceItems) {
      state.itemOrder = [];
      state.items = new Map();
      state.sentItemIds = new Set();
      state.heldReplyText = "";
      state.heldReplyKind = "plain_reply";
      state.heldReplyPreserveMarkdown = false;
    }
    if (state.itemOrder.length > 0) {
      return;
    }
    this.upsertItem(state, {
      itemId: `result-${state.turnId || state.threadId}`,
      text: normalized,
      completed: true,
      preserveMarkdown,
    });
  }

  upsertItem(state, { itemId, text, completed, preserveBlock = false, preserveMarkdown = false }) {
    if (!text) {
      return;
    }
    if (!state.items.has(itemId)) {
      state.itemOrder.push(itemId);
      state.items.set(itemId, {
        currentText: "",
        completedText: "",
        completed: false,
        preserveBlock: false,
        preserveMarkdown: false,
      });
    }

    const current = state.items.get(itemId);
    current.preserveBlock = Boolean(current.preserveBlock || preserveBlock);
    current.preserveMarkdown = Boolean(current.preserveMarkdown || preserveMarkdown);
    if (completed) {
      current.currentText = text;
      current.completedText = text;
      current.completed = true;
      return;
    }

    current.currentText = appendStreamingText(current.currentText, text);
  }

  setItemText(state, itemId, text, completed) {
    if (!text) {
      return;
    }
    if (!state.items.has(itemId)) {
      state.itemOrder.push(itemId);
      state.items.set(itemId, {
        currentText: "",
        completedText: "",
        completed: false,
        preserveBlock: false,
        preserveMarkdown: false,
      });
    }

    const current = state.items.get(itemId);
    current.currentText = text;
    if (completed) {
      current.completedText = text;
    }
    current.completed = Boolean(completed);
  }

  async flush(state, { force }) {
    const previous = state.flushPromise || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.flushNow(state, { force }));
    const tracked = current.finally(() => {
      const latestState = this.stateByRunKey.get(state.runKey);
      if (latestState && latestState.flushPromise === tracked) {
        latestState.flushPromise = null;
      }
    });
    state.flushPromise = tracked;
    await tracked;
  }

  async flushNow(state, { force }) {
    if (!state.replyTarget) {
      return;
    }

    if (state.replyTarget.provider === "system") {
      await this.flushSystemReply(state, { force });
      return;
    }

    const pendingDeliveries = collectPendingReplyDeliveries(state, { force });
    if (!pendingDeliveries.length) {
      if (force && state.heldReplyText) {
        state.sendChain = state.sendChain.then(() => this.flushHeldReply(state)).catch((error) => {
          console.error(`[cyberboss] failed to deliver held reply thread=${state.threadId}: ${error.message}`);
        });
        await state.sendChain;
      }
      return;
    }

    state.sendChain = state.sendChain.then(async () => {
      for (let index = 0; index < pendingDeliveries.length; index += 1) {
        const delivery = pendingDeliveries[index];
        await this.sendReplyDelivery(state, delivery, {
          prependDeferredPrefix: index === 0 && Boolean(state.deferredReplyPrefix),
        });
        state.sentItemIds.add(delivery.itemId);
        if (index === 0 && state.deferredReplyPrefix) {
          state.deferredReplyPrefix = "";
        }
      }
      if (force) {
        await this.flushHeldReply(state);
      }
    }).catch((error) => {
      const failedDelivery = pendingDeliveries[0];
      const failedText = buildDeliveryPreviewText(failedDelivery);
      void this.deferSystemReply(state, buildEffectiveReplyText(state.deferredReplyPrefix, failedText), error, "plain_reply");
      console.error(`[cyberboss] failed to deliver reply thread=${state.threadId}: ${error.message}`);
    });

    await state.sendChain;
  }

  async flushSystemReply(state, { force }) {
    if (!force) {
      return;
    }

    const fullReplyText = buildReplyText(state, { completedOnly: false });
    const replyText = state.systemFinalText || fullReplyText;
    const resolved = resolvePreferredSystemReplyAction(replyText, fullReplyText);
    if (resolved.kind === "silent") {
      this.markAllItemsSent(state);
      console.log(
        `[cyberboss] suppressed system reply thread=${state.threadId} action=silent preview=${JSON.stringify(replyText.slice(0, 120))}`
      );
      return;
    }

    if (resolved.kind !== "send_message") {
      console.error(
        `[cyberboss] invalid system reply thread=${state.threadId} reason=${resolved.reason} preview=${JSON.stringify(replyText.slice(0, 160))}`
      );
      return;
    }

    state.sendChain = state.sendChain.then(async () => {
      await this.sendSystemReply(state, resolved.message);
      await this.flushHeldReply(state);
      this.markAllItemsSent(state);
    }).catch((error) => {
      console.error(`[cyberboss] failed to deliver system reply thread=${state.threadId}: ${error.message}`);
    });

    await state.sendChain;
  }

  async sendReplyDelivery(state, delivery, { prependDeferredPrefix = false } = {}) {
    if (!delivery || !state.replyTarget) {
      return;
    }

    if (delivery.kind === "silent") {
      return;
    }

    if (delivery.kind === "invalid_action") {
      console.error(
        `[cyberboss] invalid structured action item thread=${state.threadId} reason=${delivery.reason} preview=${JSON.stringify((delivery.sourceText || "").slice(0, 160))}`
      );
      return;
    }

    const baseText = trimDeliveredPrefix(delivery.kind === "action" ? delivery.message : delivery.text, state.sentReplyText);
    if (!baseText) {
      return true;
    }

    const payload = {
      userId: state.replyTarget.userId,
      text: prependDeferredPrefix ? buildEffectiveReplyText(state.deferredReplyPrefix, baseText) : baseText,
      contextToken: state.replyTarget.contextToken,
    };
    if (prependDeferredPrefix || delivery.preserveBlock || delivery.preserveMarkdown) {
      payload.preserveBlock = true;
    }
    if (delivery.preserveMarkdown) {
      payload.preserveMarkdown = true;
    }
    const result = await this.sendTextWithRetry(state, payload, { kind: "plain_reply" });
    if (result.sent) {
      rememberDeliveredReplyText(state, result.deliveredText || payload.text);
    }
    if (result.heldText) {
      rememberHeldReplyText(state, result.heldText, {
        kind: "plain_reply",
        preserveMarkdown: Boolean(payload.preserveMarkdown),
      });
    }
    if (result.deferredText) {
      await this.deferSystemReply(state, result.deferredText, createDeliveryBudgetError(), "plain_reply", {
        allowNonContextFailure: true,
      });
    }
    return true;
  }

  async sendSystemReply(state, text) {
    const initialTarget = state.replyTarget;
    const replyText = trimDeliveredPrefix(text, state.sentReplyText);
    if (!replyText) {
      return;
    }
    const payload = {
      userId: initialTarget.userId,
      text: replyText,
      contextToken: initialTarget.contextToken,
      preserveMarkdown: true,
    };
    const result = await this.sendTextWithRetry(state, payload, { kind: "system_reply" });
    if (result.sent) {
      rememberDeliveredReplyText(state, result.deliveredText || payload.text);
    }
    if (result.heldText) {
      rememberHeldReplyText(state, result.heldText, {
        kind: "system_reply",
        preserveMarkdown: Boolean(payload.preserveMarkdown),
      });
    }
    if (result.deferredText) {
      await this.deferSystemReply(state, result.deferredText, createDeliveryBudgetError(), "system_reply", {
        allowNonContextFailure: true,
      });
    }
  }

  async flushHeldReply(state) {
    const heldText = trimOuterBlankLines(normalizeLineEndings(state.heldReplyText || ""));
    if (!heldText || !state.replyTarget) {
      return;
    }

    state.heldReplyText = "";
    const payload = {
      userId: state.replyTarget.userId,
      text: heldText,
      contextToken: state.replyTarget.contextToken,
      finalBurst: true,
    };
    if (state.heldReplyPreserveMarkdown) {
      payload.preserveMarkdown = true;
      payload.preserveBlock = true;
    }

    const result = await this.sendTextWithRetry(state, payload, { kind: state.heldReplyKind || "plain_reply" });
    if (result.sent) {
      rememberDeliveredReplyText(state, result.deliveredText || heldText);
    }
    if (result.heldText) {
      rememberHeldReplyText(state, result.heldText, {
        kind: state.heldReplyKind || "plain_reply",
        preserveMarkdown: Boolean(state.heldReplyPreserveMarkdown),
      });
    }
    if (result.deferredText || state.heldReplyText) {
      const deferredText = trimOuterBlankLines([result.deferredText, state.heldReplyText].filter(Boolean).join("\n\n"));
      state.heldReplyText = "";
      await this.deferSystemReply(state, deferredText, createDeliveryBudgetError(), state.heldReplyKind || "plain_reply", {
        allowNonContextFailure: true,
      });
    }
  }

  async sendTextWithRetry(state, payload, { kind }) {
    const initialTarget = state.replyTarget;
    try {
      const result = await this.channelAdapter.sendText(payload);
      return normalizeSendTextResult(result, payload.text);
    } catch (error) {
      const retryTarget = this.resolveRetriableReplyTarget(initialTarget, error);
      if (!retryTarget) {
        const deferred = await this.deferSystemReply(state, payload.text, error, kind);
        if (deferred) {
          return { sent: false, deliveredText: "", deferredText: "" };
        }
        throw error;
      }
      console.warn(
        `[cyberboss] system reply retrying with refreshed context token thread=${state.threadId} user=${retryTarget.userId}`
      );
      try {
        const retryPayload = {
          userId: retryTarget.userId,
          text: payload.text,
          contextToken: retryTarget.contextToken,
        };
        if (payload.preserveBlock) {
          retryPayload.preserveBlock = true;
        }
        if (payload.preserveMarkdown) {
          retryPayload.preserveMarkdown = true;
        }
        if (payload.finalBurst) {
          retryPayload.finalBurst = true;
        }
        const result = await this.channelAdapter.sendText(retryPayload);
        state.replyTarget = retryTarget;
        if (state.bindingKey) {
          this.replyTargetByBindingKey.set(state.bindingKey, {
            userId: retryTarget.userId,
            contextToken: retryTarget.contextToken,
            provider: retryTarget.provider,
          });
        }
        return normalizeSendTextResult(result, retryPayload.text);
      } catch (retryError) {
        const deferred = await this.deferSystemReply(state, payload.text, retryError, kind);
        if (deferred) {
          return { sent: false, deliveredText: "", deferredText: "" };
        }
        throw retryError;
      }
    }
  }

  async deferSystemReply(state, text, error, kind = "plain_reply", { allowNonContextFailure = false } = {}) {
    if (typeof this.onDeferredSystemReply !== "function") {
      return false;
    }
    if (!allowNonContextFailure && !isSystemReplyContextFailure(error)) {
      return false;
    }
    const target = state?.replyTarget || {};
    if (!target.userId || !text) {
      return false;
    }
    try {
      await this.onDeferredSystemReply({
        threadId: state.threadId,
        userId: target.userId,
        text,
        error,
        kind,
      });
      console.warn(
        `[cyberboss] deferred system reply until the next inbound message thread=${state.threadId} user=${target.userId}`
      );
      return true;
    } catch (deferError) {
      console.error(`[cyberboss] failed to defer system reply thread=${state.threadId}: ${deferError.message}`);
      return false;
    }
  }

  resolveRetriableReplyTarget(currentTarget, error) {
    if (!isSystemReplyContextFailure(error)) {
      return null;
    }
    if (!currentTarget?.userId) {
      return null;
    }
    if (typeof this.channelAdapter.getKnownContextTokens !== "function") {
      return null;
    }
    const tokens = this.channelAdapter.getKnownContextTokens();
    const refreshedContextToken = normalizeText(tokens?.[currentTarget.userId]);
    if (!refreshedContextToken || refreshedContextToken === currentTarget.contextToken) {
      return null;
    }
    return {
      userId: currentTarget.userId,
      contextToken: refreshedContextToken,
      provider: currentTarget.provider,
    };
  }

  disposeRunState(runKey) {
    const normalizedRunKey = normalizeText(runKey);
    if (!normalizedRunKey) {
      return;
    }
    this.replyTargetByTurnKey.delete(normalizedRunKey);
    this.stateByRunKey.delete(normalizedRunKey);
  }

  bindQueuedReplyTargetsToActiveThreadRuns(threadId) {
    const queue = this.replyTargetQueueByThreadId.get(threadId);
    if (!Array.isArray(queue) || !queue.length) {
      return;
    }
    const states = [...this.stateByRunKey.values()]
      .filter((state) => state.threadId === threadId && !state.threadReplyTargetAttached)
      .sort((left, right) => left.sequence - right.sequence);
    for (const state of states) {
      const nextTarget = queue.shift();
      if (!nextTarget) {
        break;
      }
      this.applyThreadReplyTarget(state, nextTarget);
    }
    if (queue.length) {
      this.replyTargetQueueByThreadId.set(threadId, queue);
      return;
    }
    this.replyTargetQueueByThreadId.delete(threadId);
  }

  consumeQueuedReplyTarget(threadId) {
    const queue = this.replyTargetQueueByThreadId.get(threadId);
    if (!Array.isArray(queue) || !queue.length) {
      return null;
    }
    const target = queue.shift() || null;
    if (queue.length) {
      this.replyTargetQueueByThreadId.set(threadId, queue);
    } else {
      this.replyTargetQueueByThreadId.delete(threadId);
    }
    return target;
  }

  applyThreadReplyTarget(state, target) {
    state.replyTarget = {
      userId: target.userId,
      contextToken: target.contextToken,
      provider: target.provider,
    };
    state.threadReplyTargetAttached = true;
  }

  markAllItemsSent(state) {
    for (const itemId of state.itemOrder) {
      state.sentItemIds.add(itemId);
    }
  }
}

function buildRunKey(threadId, turnId = "") {
  const normalizedThreadId = normalizeText(threadId);
  const normalizedTurnId = normalizeText(turnId);
  return normalizedTurnId
    ? `${normalizedThreadId}:${normalizedTurnId}`
    : `${normalizedThreadId}:pending`;
}

function buildReplyText(state, { completedOnly }) {
  const parts = [];
  for (const itemId of state.itemOrder) {
    const item = state.items.get(itemId);
    if (!item) {
      continue;
    }

    const sourceText = completedOnly
      ? (item.completed ? item.completedText : "")
      : (item.completed ? item.completedText : item.currentText);
    const normalized = trimOuterBlankLines(sourceText);
    if (normalized) {
      parts.push(normalized);
    }
  }
  return parts.join("\n\n");
}

function collectPendingReplyDeliveries(state, { force }) {
  const pending = [];
  for (const itemId of state.itemOrder) {
    if (state.sentItemIds.has(itemId)) {
      continue;
    }
    const item = state.items.get(itemId);
    if (!item) {
      continue;
    }
    const sourceText = resolvePlainReplySourceText(item, force);
    if (!sourceText) {
      continue;
    }
    const structuredAction = classifyReplyItemSourceText(sourceText);
    if (structuredAction) {
      pending.push(buildActionDelivery(itemId, sourceText, structuredAction));
      continue;
    }
    const preserveMarkdown = Boolean(item.preserveMarkdown);
    const replyText = preserveMarkdown ? sourceText : markdownToPlainText(sourceText);
    const sanitizedText = sanitizeReplyText(replyText);
    if (!sanitizedText) {
      continue;
    }
    pending.push({
      itemId,
      kind: "plain",
      text: sanitizedText,
      preserveBlock: Boolean(item.preserveBlock),
      preserveMarkdown,
    });
  }
  return pending;
}

function resolvePlainReplySourceText(item, force) {
  if (!item || typeof item !== "object") {
    return "";
  }
  if (item.completed) {
    return trimOuterBlankLines(item.completedText || item.currentText || "");
  }
  if (!force) {
    return "";
  }
  return trimOuterBlankLines(item.currentText || "");
}

function buildEffectiveReplyText(deferredPrefix, replyText) {
  const prefix = trimOuterBlankLines(normalizeLineEndings(deferredPrefix));
  const body = trimOuterBlankLines(normalizeLineEndings(replyText));
  if (prefix && body) {
    return `${prefix}\n\n${CURRENT_REPLY_HEADER}\n${body}`;
  }
  return prefix || body;
}

function rememberDeliveredReplyText(state, text) {
  const current = normalizeLineEndings(state.sentReplyText || "");
  const delivered = trimOuterBlankLines(normalizeLineEndings(text));
  if (!delivered) {
    return;
  }
  state.sentReplyText = current ? appendStreamingText(current, `\n\n${delivered}`) : delivered;
}

function rememberHeldReplyText(state, text, { kind = "plain_reply", preserveMarkdown = false } = {}) {
  const current = normalizeLineEndings(state.heldReplyText || "");
  const held = trimOuterBlankLines(normalizeLineEndings(text));
  if (!held) {
    return;
  }
  state.heldReplyText = current ? appendStreamingText(current, `\n\n${held}`) : held;
  state.heldReplyKind = kind || state.heldReplyKind || "plain_reply";
  state.heldReplyPreserveMarkdown = Boolean(state.heldReplyPreserveMarkdown || preserveMarkdown);
}

function normalizeSendTextResult(result, fallbackText) {
  if (!result || typeof result !== "object") {
    return {
      sent: true,
      deliveredText: fallbackText,
      heldText: "",
      deferredText: "",
    };
  }
  const deliveredText = trimOuterBlankLines(normalizeLineEndings(result.deliveredText || ""));
  const heldText = trimOuterBlankLines(normalizeLineEndings(result.heldText || ""));
  const deferredText = trimOuterBlankLines(normalizeLineEndings(result.deferredText || ""));
  return {
    sent: Boolean(deliveredText || (!heldText && !deferredText)),
    deliveredText: deliveredText || fallbackText,
    heldText,
    deferredText,
  };
}

function createDeliveryBudgetError() {
  const error = new Error("WeChat delivery budget reached; deferred remaining reply text");
  error.code = "WEIXIN_DELIVERY_BUDGET_REACHED";
  return error;
}

function trimDeliveredPrefix(text, deliveredText) {
  const candidate = trimOuterBlankLines(normalizeLineEndings(text));
  const delivered = trimOuterBlankLines(normalizeLineEndings(deliveredText));
  if (!candidate || !delivered) {
    return candidate;
  }

  const maxOverlap = Math.min(candidate.length, delivered.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (delivered.slice(-size) === candidate.slice(0, size)) {
      return trimOuterBlankLines(candidate.slice(size));
    }
  }
  return candidate;
}

function markdownToPlainText(text) {
  let result = normalizeLineEndings(text);
  result = result.replace(/```([^\n]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const label = String(language || "").trim();
    const body = indentBlock(String(code || ""));
    return label ? `\n${label}:\n${body}\n` : `\nCode:\n${body}\n`;
  });
  result = result.replace(/```([^\n]*)\n?([\s\S]*)$/g, (_, language, code) => {
    const label = String(language || "").trim();
    const body = indentBlock(String(code || ""));
    return label ? `\n${label}:\n${body}\n` : `\nCode:\n${body}\n`;
  });
  result = result.replace(/!\[[^\]]*]\([^)]*\)/g, "");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  result = result.replace(/`([^`]+)`/g, "$1");
  result = result.replace(/^#{1,6}\s*(.+)$/gm, "$1");
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/\*([^*]+)\*/g, "$1");
  result = result.replace(/^>\s?/gm, "> ");
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner) =>
    String(inner || "").split("|").map((cell) => cell.trim()).join("  ")
  );
  result = result.replace(/\n{3,}/g, "\n\n");
  return trimOuterBlankLines(result);
}

function appendStreamingText(current, next) {
  const base = String(current || "");
  const incoming = String(next || "");
  if (!incoming) {
    return base;
  }
  if (!base) {
    return incoming;
  }
  if (base.endsWith(incoming)) {
    return base;
  }
  if (incoming.startsWith(base)) {
    return incoming;
  }

  const maxOverlap = Math.min(base.length, incoming.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (base.slice(-size) === incoming.slice(0, size)) {
      return `${base}${incoming.slice(size)}`;
    }
  }

  return `${base}${incoming}`;
}

function indentBlock(text) {
  const normalized = trimOuterBlankLines(normalizeLineEndings(text));
  if (!normalized) {
    return "";
  }
  return normalized.split("\n").map((line) => `    ${line}`).join("\n");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeReplyTarget(target) {
  if (!target?.userId || !target?.contextToken) {
    return null;
  }
  return {
    userId: String(target.userId).trim(),
    contextToken: String(target.contextToken).trim(),
    provider: normalizeText(target.provider),
  };
}

function normalizeLineEndings(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function trimOuterBlankLines(text) {
  return String(text || "")
    .replace(/^\s*\n+/g, "")
    .replace(/\n+\s*$/g, "");
}

function sanitizeReplyText(plainReplyText) {
  const normalized = normalizeLineEndings(String(plainReplyText || ""));
  if (!normalized) {
    return "";
  }
  const protocolSanitized = sanitizeProtocolLeakText(normalized);
  return trimOuterBlankLines(protocolSanitized.text || "");
}

function resolveSystemReplyAction(replyText) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  if (!normalized) {
    return { kind: "invalid", reason: "final reply is empty" };
  }

  const candidates = extractSystemActionJsonCandidates(normalized);
  let lastInvalidAction = null;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const parsed = tryParseJson(candidates[index].text);
    const resolved = resolveParsedSystemAction(parsed);
    if (resolved) {
      if (resolved.kind === "invalid") {
        lastInvalidAction = lastInvalidAction || resolved;
        continue;
      }
      return resolved;
    }
  }

  const parsed = tryParseJson(normalized);
  const resolved = resolveParsedSystemAction(parsed);
  if (resolved) {
    return resolved;
  }
  if (lastInvalidAction) {
    return lastInvalidAction;
  }

  const autoWrapped = resolveAutoWrappedSystemText(normalized);
  if (autoWrapped) {
    return autoWrapped;
  }

  return { kind: "invalid", reason: "final reply is not a JSON object" };
}

function resolvePreferredSystemReplyAction(replyText, fallbackText = "") {
  const primary = resolveSystemReplyAction(replyText);
  if (primary.kind !== "silent") {
    return primary;
  }

  const sendMessage = resolveLatestSystemSendMessageAction(fallbackText || replyText);
  return sendMessage || primary;
}

function resolveLatestSystemSendMessageAction(replyText) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  if (!normalized) {
    return null;
  }

  const candidates = extractSystemActionJsonCandidates(normalized);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const resolved = resolveParsedSystemAction(tryParseJson(candidates[index].text));
    if (resolved?.kind === "send_message") {
      return resolved;
    }
  }

  const resolved = resolveParsedSystemAction(tryParseJson(normalized));
  return resolved?.kind === "send_message" ? resolved : null;
}

function resolveParsedSystemAction(parsed) {
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    return null;
  }

  if (!("action" in parsed) && !("cyberboss_action" in parsed)) {
    return null;
  }

  const action = normalizeSystemActionName(parsed.action || parsed.cyberboss_action);
  if (action === "silent") {
    return { kind: "silent" };
  }
  if (action !== "send_message") {
    return { kind: "invalid", reason: "unsupported action" };
  }

  const message = sanitizeProtocolLeakText(normalizeLineEndings(String(parsed.message || parsed.text || ""))).text.trim();
  if (!message) {
    return { kind: "invalid", reason: "send_message requires a non-empty message" };
  }

  return { kind: "send_message", message };
}

function classifyReplyItemSourceText(replyText) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  if (!normalized) {
    return null;
  }
  const unfenced = unwrapJsonCodeFence(normalized) || normalized;
  const stripped = unfenced.replace(/^json\s*:\s*/i, "").trim();
  const candidate = extractSystemActionJsonCandidate(stripped) || (stripped.startsWith("{") ? stripped : "");
  if (!candidate) {
    return null;
  }
  if (candidate !== stripped) {
    return null;
  }
  return resolveSystemReplyAction(candidate);
}

function unwrapJsonCodeFence(text) {
  const match = String(text || "").trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? String(match[1] || "").trim() : "";
}

function buildActionDelivery(itemId, sourceText, action) {
  if (!action || typeof action !== "object") {
    return null;
  }
  if (action.kind === "silent") {
    return { itemId, kind: "silent", sourceText };
  }
  if (action.kind === "send_message") {
    return { itemId, kind: "action", sourceText, message: action.message };
  }
  return {
    itemId,
    kind: "invalid_action",
    sourceText,
    reason: action.reason || "invalid structured action",
  };
}

function buildDeliveryPreviewText(delivery) {
  if (!delivery || typeof delivery !== "object") {
    return "";
  }
  if (delivery.kind === "action") {
    return delivery.message || "";
  }
  if (delivery.kind === "plain") {
    return delivery.text || "";
  }
  return "";
}

function normalizeSystemActionName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function resolveAutoWrappedSystemText(replyText) {
  const message = sanitizeAutoWrappedSystemText(replyText);
  if (!message) {
    return null;
  }
  return { kind: "send_message", message };
}

function sanitizeAutoWrappedSystemText(replyText) {
  let text = normalizeLineEndings(String(replyText || ""))
    .replace(/^\s*\**(?:LLM Running \(Turn \d+\)|Turn \d+) \.\.\.\**\s*$/gmi, "")
    .replace(/\[ROUND END\]/gi, "")
    .replace(/<summary>\s*[\s\S]*?\s*<\/summary>/gi, "");

  if (/\bSYSTEM ACTION MODE\b/i.test(text)) {
    return "";
  }
  if (/^\s*\{/.test(text.trim())) {
    return "";
  }

  text = stripFencedCodeBlocks(text);
  text = stripSystemToolLogLines(text);
  const sanitized = sanitizeProtocolLeakText(text);
  return trimOuterBlankLines(sanitized.text || "");
}

function stripFencedCodeBlocks(text) {
  return normalizeLineEndings(text).replace(/```[\s\S]*?```/g, "");
}

function stripSystemToolLogLines(text) {
  const lines = normalizeLineEndings(text).split("\n");
  const kept = [];
  for (const line of lines) {
    if (isSystemToolLogLine(line)) {
      break;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function isSystemToolLogLine(line) {
  return /^\s*(?:🛠️|馃洜锔\?)\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/u.test(line)
    || /^\s*(?:🛠️|馃洜锔\?)\s*Tool:\s*`?[A-Za-z_][A-Za-z0-9_]*`?/u.test(line)
    || /\bcode_run\s*\(/.test(line);
}

function extractSystemActionJsonCandidates(text) {
  const normalized = normalizeLineEndings(String(text || "")).trim();
  if (!normalized) {
    return [];
  }

  const candidates = [];
  const fencedPattern = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  for (const match of normalized.matchAll(fencedPattern)) {
    candidates.push({
      index: match.index ?? 0,
      text: String(match[1] || "").trim(),
    });
  }

  for (let index = normalized.indexOf("{"); index >= 0; index = normalized.indexOf("{", index + 1)) {
    const end = findJsonObjectEnd(normalized, index);
    if (end < 0) {
      continue;
    }
    candidates.push({
      index,
      text: normalized.slice(index, end + 1).trim(),
    });
  }

  return candidates
    .filter((candidate) => candidate.text)
    .sort((left, right) => left.index - right.index);
}

function extractSystemActionJsonCandidate(text) {
  const normalized = normalizeLineEndings(String(text || "")).trim();
  if (!normalized || !normalized.endsWith("}")) {
    return "";
  }
  if (normalized.startsWith("{")) {
    return normalized;
  }
  const candidates = extractSystemActionJsonCandidates(normalized);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index].text;
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
      continue;
    }
    const parsed = tryParseJson(candidate);
    if (resolveParsedSystemAction(parsed)) {
      return candidate;
    }
  }
  return "";
}

function findJsonObjectEnd(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function isSystemReplyContextFailure(error) {
  const message = String(error?.message || "");
  const ret = normalizeNumericErrorCode(error?.ret);
  const errcode = normalizeNumericErrorCode(error?.errcode);
  return ret === -2
    || errcode === -2
    || message.includes("sendMessage ret=-2")
    || message.includes("errcode=-2");
}

function normalizeNumericErrorCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

module.exports = {
  StreamDelivery,
  resolveLatestSystemSendMessageAction,
};
