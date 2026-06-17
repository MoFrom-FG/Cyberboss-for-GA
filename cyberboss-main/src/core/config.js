const path = require("path");
const { DEFAULT_PUSH_URL } = require("../services/today-task-service");

function readConfig() {
  const argv = process.argv.slice(2);
  const mode = argv[0] || "";
  const workspaceRoot = resolveWorkspaceRootEnv();
  const stateDir = resolvePathEnv("CYBERBOSS_STATE_DIR", workspaceRoot, resolveDefaultCyberbossDataDir());
  const cyberbossHome = resolvePathEnv("CYBERBOSS_HOME", workspaceRoot, path.resolve(__dirname, "..", ".."));

  return {
    mode,
    argv,
    stateDir,
    cyberbossHome,
    workspaceId: readTextEnv("CYBERBOSS_WORKSPACE_ID") || "default",
    workspaceRoot,
    userName: readTextEnv("CYBERBOSS_USER_NAME") || "User",
    userGender: readTextEnv("CYBERBOSS_USER_GENDER") || "female",
    botName: readTextEnv("CYBERBOSS_BOT_NAME") || "CyberBoss",
    helpZh: readHelpZhEnv(),
    allowedUserIds: readListEnv("CYBERBOSS_ALLOWED_USER_IDS"),
    channel: readTextEnv("CYBERBOSS_CHANNEL") || "weixin",
    runtime: readTextEnv("CYBERBOSS_RUNTIME") || "genericagent",
    timelineCommand: readTextEnv("CYBERBOSS_TIMELINE_COMMAND") || "timeline-for-agent",
    accountId: readTextEnv("CYBERBOSS_ACCOUNT_ID"),
    weixinBaseUrl: readTextEnv("CYBERBOSS_WEIXIN_BASE_URL") || "https://ilinkai.weixin.qq.com",
    weixinCdnBaseUrl: readTextEnv("CYBERBOSS_WEIXIN_CDN_BASE_URL") || "https://novac2c.cdn.weixin.qq.com/c2c",
    weixinConfigFile: path.join(stateDir, "weixin-config.json"),
    weixinMinChunkChars: readIntEnv("CYBERBOSS_WEIXIN_MIN_CHUNK_CHARS"),
    weixinQrBotType: readTextEnv("CYBERBOSS_WEIXIN_QR_BOT_TYPE") || "3",
    accountsDir: path.join(stateDir, "accounts"),
    reminderQueueFile: path.join(stateDir, "reminder-queue.json"),
    systemMessageQueueFile: path.join(stateDir, "system-message-queue.json"),
    deferredSystemReplyQueueFile: path.join(stateDir, "deferred-system-replies.json"),
    checkinConfigFile: path.join(stateDir, "checkin-config.json"),
    turnProgressConfigFile: path.join(stateDir, "turn-progress-config.json"),
    timelineScreenshotQueueFile: path.join(stateDir, "timeline-screenshot-queue.json"),
    projectToolContextFile: path.join(stateDir, "project-tool-runtime-context.json"),
    wechatMemoryDir: path.join(stateDir, "wechat-memory"),
    wechatRuntimeDir: path.join(stateDir, "wechat-runtime"),
    wechatMaintenanceStateFile: path.join(stateDir, "wechat-runtime", "maintenance-state.json"),
    weixinInstructionsFile: path.join(stateDir, "weixin-instructions.md"),
    weixinOperationsFile: path.join(cyberbossHome, "templates", "weixin-operations.md"),
    diaryDir: path.join(stateDir, "diary"),
    locationStoreFile: path.join(stateDir, "locations.json"),
    locationHost: readTextEnv("CYBERBOSS_LOCATION_HOST") || "0.0.0.0",
    locationPort: readIntEnv("CYBERBOSS_LOCATION_PORT") || 4318,
    locationToken: readTextEnv("CYBERBOSS_LOCATION_TOKEN"),
    locationHistoryLimit: readIntEnv("CYBERBOSS_LOCATION_HISTORY_LIMIT") || 1000,
    locationMovementEventLimit: readIntEnv("CYBERBOSS_LOCATION_MOVEMENT_EVENT_LIMIT"),
    locationBatteryHistoryLimit: readIntEnv("CYBERBOSS_LOCATION_BATTERY_HISTORY_LIMIT"),
    locationKnownPlaces: readKnownPlacesEnv(),
    locationKnownPlaceRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_PLACE_RADIUS_METERS") || 150,
    locationStayMergeRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_STAY_MERGE_RADIUS_METERS") || 100,
    locationStayBreakConfirmRadiusMeters: readIntEnv("CYBERBOSS_LOCATION_STAY_BREAK_RADIUS_METERS") || 200,
    locationStayBreakConfirmSamples: readIntEnv("CYBERBOSS_LOCATION_STAY_BREAK_SAMPLES") || 2,
    locationMajorMoveThresholdMeters: readIntEnv("CYBERBOSS_LOCATION_MAJOR_MOVE_THRESHOLD_METERS") || 1000,
    bridgeInstanceLockFile: path.join(stateDir, "cyberboss-bridge.pid"),
    startWithLocationServer: resolveLocationServerEnabled({
      mode,
      enabled: readOptionalBoolEnv("CYBERBOSS_ENABLE_LOCATION_SERVER"),
    }),
    syncBufferDir: path.join(stateDir, "sync-buffers"),
    gaPythonPath: readTextEnv("CYBERBOSS_GA_PYTHON") || resolveCurrentCondaPython() || "python",
    gaAgentMainPath: readTextEnv("CYBERBOSS_GA_AGENTMAIN") || resolveDefaultGenericAgentMain(),
    gaTaskBaseDir: readTextEnv("CYBERBOSS_GA_TASK_DIR"),
    gaLlmNo: readIntEnv("CYBERBOSS_GA_LLM_NO") || 0,
    gaVerbose: readBoolEnv("CYBERBOSS_GA_VERBOSE"),
    todayTaskAuthCode: readTextEnv("CYBERBOSS_TODAY_TASK_AUTH_CODE"),
    todayTaskPushUrl: readTextEnv("CYBERBOSS_TODAY_TASK_PUSH_URL") || DEFAULT_PUSH_URL,
    todayTaskTimeoutMs: readIntEnv("CYBERBOSS_TODAY_TASK_TIMEOUT_MS") || 30_000,
    sessionsFile: path.join(stateDir, "sessions.json"),
    startWithCheckin: (mode === "start" && hasArgFlag(argv, "--checkin")) || readBoolEnv("CYBERBOSS_ENABLE_CHECKIN"),
  };
}

function resolveWorkspaceRootEnv() {
  const configured = readTextEnv("CYBERBOSS_WORKSPACE_ROOT");
  return path.resolve(configured || process.cwd());
}

function resolvePathEnv(name, baseDir, fallback) {
  const configured = readTextEnv(name);
  if (!configured) {
    return path.resolve(fallback);
  }
  if (path.isAbsolute(configured)) {
    return path.resolve(configured);
  }
  return path.resolve(baseDir || process.cwd(), configured);
}

function readListEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readTextEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readHelpZhEnv() {
  const value = readTextEnv("CYBERBOSS_HELP_ZH").toLowerCase();
  if (!value) {
    return false;
  }
  if (value === "zh" || value === "zh-cn" || value === "cn" || value === "chinese") {
    return true;
  }
  if (value === "en" || value === "en-us" || value === "english") {
    return false;
  }
  return readBoolEnv("CYBERBOSS_HELP_ZH");
}

function readOptionalBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  return undefined;
}

function readIntEnv(name) {
  const value = readTextEnv(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readKnownPlacesEnv() {
  const fromJson = parseKnownPlacesJson(readTextEnv("CYBERBOSS_LOCATION_KNOWN_PLACES"));
  const fromCenters = [
    parseKnownPlaceCenter("home", readTextEnv("CYBERBOSS_LOCATION_HOME_CENTER")),
    parseKnownPlaceCenter("work", readTextEnv("CYBERBOSS_LOCATION_WORK_CENTER")),
  ].filter(Boolean);
  return [...fromJson, ...fromCenters];
}

function parseKnownPlacesJson(value) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseKnownPlaceCenter(tag, value) {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return { tag, latitude, longitude };
}

function hasArgFlag(argv, flag) {
  return Array.isArray(argv) && argv.some((item) => String(item || "").trim() === flag);
}

function resolveLocationServerEnabled({ mode, enabled }) {
  if (mode !== "start") {
    return false;
  }
  if (typeof enabled === "boolean") {
    return enabled;
  }
  return false;
}

function resolveDefaultGenericAgentMain() {
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "GenericAgent-main", "agentmain.py"),
    path.resolve(__dirname, "..", "..", "..", "..", "agentmain.py"),
  ];
  return candidates.find((candidate) => fileExists(candidate)) || candidates[0];
}

function resolveDefaultCyberbossDataDir() {
  return path.resolve(__dirname, "..", "..", "..", "cyberboss-data");
}

function resolveCurrentCondaPython() {
  const condaPrefix = readTextEnv("CONDA_PREFIX");
  if (!condaPrefix) {
    return "";
  }
  return process.platform === "win32"
    ? path.join(condaPrefix, "python.exe")
    : path.join(condaPrefix, "bin", "python");
}

function fileExists(filePath) {
  try {
    return require("fs").existsSync(filePath);
  } catch {
    return false;
  }
}

module.exports = { readConfig };
