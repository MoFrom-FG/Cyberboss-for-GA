"use strict";

const TURN_MARKER_RE = /^\s*\**(?:LLM Running \(Turn \d+\)|Turn \d+) \.\.\.\**\s*$/gmi;
const SUMMARY_RE = /<summary>\s*([\s\S]*?)\s*<\/summary>/gi;
const INTERNAL_BLOCK_RE = /<(thinking|tool_use|tool_call|file_content)\b[^>]*>[\s\S]*?<\/\1>/gi;
const TOOL_ICON_RE = "(?:🛠️|馃洜锔\\?)";

function normalizeGenericAgentOutput(text) {
  return compactBlankLines(normalizeGenericAgentTurnOutputs(text).join("\n\n"));
}

function normalizeGenericAgentTurnOutputs(text) {
  const normalized = normalizeLineEndings(text);
  if (!normalized.trim()) {
    return [];
  }

  const segments = splitTurnSegments(normalized);
  const visible = [];
  for (const segment of segments) {
    const normalizedSegment = normalizeTurnSegment(segment);
    if (normalizedSegment) {
      visible.push(normalizedSegment);
    }
  }
  return visible;
}

function normalizeGenericAgentLastTurnOutput(text) {
  const normalized = normalizeLineEndings(text);
  if (!normalized.trim()) {
    return "";
  }

  const segments = splitTurnSegments(normalized);
  const lastSegment = segments.length ? segments[segments.length - 1] : normalized;
  return normalizeTurnSegment(lastSegment);
}

function splitTurnSegments(text) {
  const cleaned = normalizeLineEndings(text);
  if (!TURN_MARKER_RE.test(cleaned)) {
    TURN_MARKER_RE.lastIndex = 0;
    return [cleaned];
  }
  TURN_MARKER_RE.lastIndex = 0;
  return cleaned.split(TURN_MARKER_RE).filter((part) => part && part.trim());
}

function normalizeTurnSegment(segment) {
  let visible = stripInternalBlocks(segment);
  visible = stripToolSections(visible);
  visible = stripLooseToolLines(visible);
  visible = stripToolResultNoise(visible);
  visible = stripMarkdownFenceWrappers(visible);
  visible = compactBlankLines(visible);

  if (visible) {
    return visible;
  }

  return "";
}

function stripInternalBlocks(text) {
  return normalizeLineEndings(text)
    .replace(SUMMARY_RE, "")
    .replace(INTERNAL_BLOCK_RE, "");
}

function stripToolSections(text) {
  const lines = normalizeLineEndings(text).split("\n");
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isVerboseToolHeader(line)) {
      kept.push(line);
      continue;
    }
    break;
  }
  return kept.join("\n");
}

function stripLooseToolLines(text) {
  const lines = normalizeLineEndings(text).split("\n");
  const kept = [];
  for (const line of lines) {
    if (isCompactToolLine(line)) {
      break;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function stripToolResultNoise(text) {
  return normalizeLineEndings(text)
    .replace(/^\s*\[Action\][\s\S]*?(?=^\s*(?:\[Status\]|\[Stdout\]|\[Stderr\])|\s*$)/gmi, "")
    .replace(/^\s*\[Status\].*$/gmi, "")
    .replace(/^\s*\[(?:Stdout|Stderr)\]\s*$/gmi, "");
}

function stripMarkdownFenceWrappers(text) {
  return normalizeLineEndings(text)
    .replace(/^\s*`{4,}\s*(?:text|json|python|javascript|powershell)?\s*$/gmi, "")
    .replace(/^\s*`{4,}\s*$/gmi, "");
}

function isVerboseToolHeader(line) {
  return new RegExp(`^\\s*${TOOL_ICON_RE}\\s*Tool:\\s*\`?[A-Za-z_][A-Za-z0-9_]*\`?`, "u").test(line);
}

function isCompactToolLine(line) {
  return new RegExp(`^\\s*${TOOL_ICON_RE}\\s*[A-Za-z_][A-Za-z0-9_]*\\s*\\(`, "u").test(line);
}

function compactBlankLines(text) {
  return normalizeLineEndings(text)
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeLineEndings(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

module.exports = {
  normalizeGenericAgentOutput,
  normalizeGenericAgentLastTurnOutput,
  normalizeGenericAgentTurnOutputs,
};
