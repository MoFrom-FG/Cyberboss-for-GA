"use strict";

const {
  normalizeGenericAgentLastTurnOutput,
  normalizeGenericAgentOutput,
} = require("./output-normalizer");

function mapGenericAgentMessageToRuntimeEvent(message) {
  if (!message || typeof message !== "object") {
    return null;
  }
  const payload = {
    threadId: normalizeText(message.threadId),
    turnId: normalizeText(message.turnId),
  };
  if (!payload.threadId) {
    return null;
  }

  switch (message.type) {
    case "turn_started":
      return {
        type: "runtime.turn.started",
        payload,
      };
    case "reply_delta":
      return {
        type: "runtime.reply.delta",
        payload: {
          ...payload,
          itemId: normalizeText(message.itemId) || "ga-output",
          text: normalizeGenericAgentOutput(message.text),
        },
      };
    case "reply_completed":
      return {
        type: "runtime.reply.completed",
        payload: {
          ...payload,
          itemId: normalizeText(message.itemId) || "ga-output",
          text: normalizeGenericAgentOutput(message.text),
          preserveBlock: Boolean(message.preserveBlock),
          preserveMarkdown: Boolean(message.preserveMarkdown),
        },
      };
    case "turn_completed":
      return {
        type: "runtime.turn.completed",
        payload: {
          ...payload,
          text: normalizeGenericAgentOutput(message.text),
          systemFinalText: normalizeGenericAgentLastTurnOutput(message.systemFinalText || message.text),
        },
      };
    case "turn_failed":
      return {
        type: "runtime.turn.failed",
        payload: {
          ...payload,
          text: String(message.text || "GenericAgent turn failed"),
        },
      };
    default:
      return null;
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { mapGenericAgentMessageToRuntimeEvent };
