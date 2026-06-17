const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const { readConfig } = require("./core/config");
const { CyberbossApp } = require("./core/app");
const { runSystemCheckinPoller } = require("./app/system-checkin-poller");
const { buildTerminalHelpText } = require("./core/command-registry");
const { createProjectTooling } = require("./tools/create-project-tooling");
const { runToolMcpServer } = require("./tools/mcp-stdio-server");

function ensureDefaultStateDirectory() {
  fs.mkdirSync(path.resolve(__dirname, "..", "..", "cyberboss-data"), { recursive: true });
}

function loadEnv() {
  ensureDefaultStateDirectory();
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.resolve(__dirname, "..", ".env"),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    dotenv.config({ path: envPath, override: true });
    return;
  }
  dotenv.config({ override: true });
}

function ensureRuntimeEnv() {
  if (!process.env.CYBERBOSS_HOME) {
    process.env.CYBERBOSS_HOME = path.resolve(__dirname, "..");
    return;
  }
  if (!path.isAbsolute(process.env.CYBERBOSS_HOME)) {
    const workspaceRoot = process.env.CYBERBOSS_WORKSPACE_ROOT
      ? path.resolve(process.env.CYBERBOSS_WORKSPACE_ROOT)
      : process.cwd();
    process.env.CYBERBOSS_HOME = path.resolve(workspaceRoot, process.env.CYBERBOSS_HOME);
  }
}

function ensureBootstrapFiles(config) {
  ensureInstructionsTemplate(config);
}

function ensureInstructionsTemplate(config) {
  const filePath = typeof config?.weixinInstructionsFile === "string"
    ? config.weixinInstructionsFile.trim()
    : "";
  if (!filePath || fs.existsSync(filePath)) {
    return;
  }

  const templatePath = path.resolve(__dirname, "..", "templates", "weixin-instructions.md");
  let template = "";
  try {
    template = fs.readFileSync(templatePath, "utf8");
  } catch {
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, template.trimEnd() + "\n", "utf8");
}

function printHelp() {
  console.log(buildTerminalHelpText());
}

let runtimeErrorHooksInstalled = false;

function installRuntimeErrorHooks() {
  if (runtimeErrorHooksInstalled) {
    return;
  }
  runtimeErrorHooksInstalled = true;

  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error(`[cyberboss] unhandled rejection ${message}`);
  });

  process.on("uncaughtException", (error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[cyberboss] uncaught exception ${message}`);
    process.exitCode = 1;
  });
}

async function main() {
  loadEnv();
  ensureRuntimeEnv();
  installRuntimeErrorHooks();
  const argv = process.argv.slice(2);
  const config = readConfig();
  ensureBootstrapFiles(config);
  const command = config.mode || "help";
  let app = null;
  const getApp = () => {
    if (!app) {
      app = new CyberbossApp(config);
    }
    return app;
  };

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(buildTerminalHelpText());
    return;
  }

  if (command === "doctor") {
    getApp().printDoctor();
    return;
  }

  if (command === "login") {
    await getApp().login();
    return;
  }

  if (command === "accounts") {
    getApp().printAccounts();
    return;
  }

  if (command === "start") {
    await getApp().start();
    return;
  }

  if (command === "tool-mcp-server") {
    const runtimeId = readFlagValue(argv.slice(1), "--runtime-id") || "";
    const workspaceRoot = readFlagValue(argv.slice(1), "--workspace-root") || process.cwd();
    const { toolHost } = createProjectTooling(config);
    runToolMcpServer({ toolHost, runtimeId, workspaceRoot });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

module.exports = { main };

function readFlagValue(args, flag) {
  if (!Array.isArray(args)) {
    return "";
  }
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      return String(args[index + 1] || "").trim();
    }
  }
  return "";
}
