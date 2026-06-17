const fs = require("fs");
const path = require("path");
const readline = require("readline");
const {
  stateDir,
  resolveSharedThreadTarget,
} = require("./shared-common");
const {
  createTaskSpec,
  resolveAgentMainPath,
  resolveTaskBaseDir,
} = require("../src/adapters/runtime/genericagent");

async function main() {
  const workspaceRoot = process.env.CYBERBOSS_WORKSPACE_ROOT || process.cwd();
  const preferActiveWorkspace = process.env.CYBERBOSS_SHARED_OPEN_EXACT_WORKSPACE !== "1";
  let currentTarget = null;
  let lastRendered = "";
  let waitingReason = "";
  let resolving = false;

  const resolveTarget = async ({ announce = false } = {}) => {
    if (resolving) {
      return currentTarget;
    }
    resolving = true;
    try {
      const resolved = resolveSharedThreadTarget(workspaceRoot, {
        preferActiveWorkspace,
        allowMissingThread: true,
      });
      if (!resolved.threadId) {
        if (currentTarget || waitingReason !== resolved.waitingReason || announce) {
          const previousThreadId = currentTarget?.threadId || "";
          currentTarget = null;
          lastRendered = "";
          waitingReason = resolved.waitingReason || "waiting for the active WeChat thread";
          const prefix = previousThreadId ? `[detached] ${previousThreadId}` : "[waiting]";
          console.log(`${prefix}\n${waitingReason}`);
        }
        return null;
      }

      const taskDir = resolveGenericAgentTaskDir({ stateDir, threadId: resolved.threadId });
      await fs.promises.mkdir(taskDir, { recursive: true });
      const nextTarget = {
        ...resolved,
        taskDir,
      };
      const changed = !currentTarget
        || currentTarget.threadId !== nextTarget.threadId
        || currentTarget.taskDir !== nextTarget.taskDir;
      if (changed) {
        const previousThreadId = currentTarget?.threadId || "";
        currentTarget = nextTarget;
        lastRendered = "";
        waitingReason = "";
        if (previousThreadId) {
          console.log(`[switched] ${previousThreadId} -> ${nextTarget.threadId}`);
        } else {
          console.log(`Connected to GenericAgent bridge files (${taskDir})`);
        }
        console.log(`Chat thread: ${nextTarget.threadId} (${nextTarget.source})`);
        console.log(`Observing workspace: ${nextTarget.workspaceRoot}`);
      }
      return currentTarget;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "unknown error");
      if (currentTarget || waitingReason !== message || announce) {
        currentTarget = null;
        lastRendered = "";
        waitingReason = message;
        console.log(`[waiting]\n${message}`);
      }
      return null;
    } finally {
      resolving = false;
    }
  };

  await resolveTarget({ announce: true });
  console.log("Type your message and press Enter to send via reply.txt. Ctrl+C to exit.\n");

  const renderLatestOutput = async () => {
    const target = await resolveTarget();
    if (!target) {
      return;
    }
    const outputFile = findLatestGenericAgentOutput(target.taskDir);
    if (!outputFile) {
      return;
    }
    const text = await fs.promises.readFile(outputFile, "utf8").catch(() => "");
    if (!text || text === lastRendered) {
      return;
    }
    const delta = text.startsWith(lastRendered) ? text.slice(lastRendered.length) : text;
    lastRendered = text;
    process.stdout.write(delta);
  };
  const timer = setInterval(() => {
    renderLatestOutput().catch(() => {});
  }, 800);
  await renderLatestOutput().catch(() => {});

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }
    const target = await resolveTarget({ announce: true });
    if (!target) {
      console.log(`[not queued] ${waitingReason || "no active WeChat companion thread yet"}`);
      rl.prompt();
      return;
    }
    fs.promises.writeFile(path.join(target.taskDir, "reply.txt"), text, "utf8").then(() => {
      console.log(`[queued for GenericAgent] ${text}`);
      rl.prompt();
    }).catch((error) => {
      console.error(`[write failed] ${error.message}`);
      rl.prompt();
    });
  });

  rl.on("close", () => {
    clearInterval(timer);
    console.log("\n[Exiting]");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    rl.close();
  });
}

function sanitizePathSegment(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "session";
}

function resolveGenericAgentTaskDir({ stateDir, threadId }) {
  const agentMainPath = resolveAgentMainPath(process.env.CYBERBOSS_GA_AGENTMAIN || "");
  const taskBaseDir = resolveTaskBaseDir({
    gaTaskBaseDir: process.env.CYBERBOSS_GA_TASK_DIR || "",
  }, agentMainPath);
  const current = createTaskSpec({ agentMainPath, taskBaseDir, threadId }).taskDir;
  if (fs.existsSync(current)) {
    return current;
  }
  const sanitizedThreadId = sanitizePathSegment(threadId);
  const flat = path.join(taskBaseDir, sanitizedThreadId);
  if (fs.existsSync(flat)) {
    return flat;
  }
  const existing = findExistingDatedGenericAgentTaskDir(taskBaseDir, sanitizedThreadId);
  if (existing) {
    return existing;
  }
  const legacy = path.join(stateDir, "legacy", "genericagent-sessions-home", sanitizedThreadId);
  if (fs.existsSync(legacy)) {
    console.warn(`Legacy GenericAgent session found at ${legacy}; using current task dir instead: ${current}`);
  }
  return current;
}

function findExistingDatedGenericAgentTaskDir(taskBaseDir, sanitizedThreadId) {
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

function findLatestGenericAgentOutput(taskDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(taskDir, { withFileTypes: true });
  } catch {
    return "";
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && /^output\d*\.txt$/i.test(entry.name))
    .map((entry) => {
      const filePath = path.join(taskDir, entry.name);
      const stat = fs.statSync(filePath);
      return { filePath, mtimeMs: stat.mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.filePath || "";
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
