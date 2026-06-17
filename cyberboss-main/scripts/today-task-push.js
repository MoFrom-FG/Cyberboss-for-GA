#!/usr/bin/env node
/**
 * CyberBoss Today Task Push CLI
 *
 * 用法:
 *   node scripts/today-task-push.js --title "标题" --result "短状态" --content-file "result.md"
 *
 * 可选:
 *   --truncate-result       允许截断超长的 result（默认拒绝并 exit 2）
 *   --task-id "自定义ID"    自定义任务ID（默认自动生成）
 *   --runtime-id "ga"       标注调用方 runtime
 *
 * Exit code 契约:
 *   0  推送成功
 *   1  推送失败或网络错误，可重试一次
 *   2  参数错误（result 太长、缺 title 等），GA 应修正调用
 *   3  配置错误（缺 authCode、.env 不可用），需用户处理
 */

const path = require("path");
const fs = require("fs");

// 切到项目根目录以加载 .env
process.chdir(path.resolve(__dirname, ".."));
require("dotenv").config();

const { TodayTaskService, DEFAULT_PUSH_URL } = require(path.resolve(__dirname, "..", "src", "services", "today-task-service"));

// ── 命令行解析 ──────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    title: "",
    result: "",
    contentFile: "",
    content: "",
    taskId: "",
    runtimeId: "",
    truncateResult: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--title":
        args.title = next || ""; i++; break;
      case "--result":
        args.result = next || ""; i++; break;
      case "--content-file":
        args.contentFile = next || ""; i++; break;
      case "--content":
        args.content = next || ""; i++; break;
      case "--task-id":
        args.taskId = next || ""; i++; break;
      case "--runtime-id":
        args.runtimeId = next || ""; i++; break;
      case "--truncate-result":
        args.truncateResult = true; break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        if (arg.startsWith("--")) {
          console.error(`UNKNOWN_ARG: ${arg}`);
          process.exit(2);
        }
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Usage: node scripts/today-task-push.js [OPTIONS]

Required:
  --title TITLE           任务标题（显示在负一屏卡片头部）
  --result RESULT         短状态文本（≤20 字，如"分析已完成"）
  --content-file FILE     包含完整 Markdown 正文的文件路径

Optional:
  --content TEXT          直接传入正文（与 --content-file 二选一，优先用 file）
  --task-id ID            自定义任务 ID（默认自动生成）
  --runtime-id ID         标注调用方，如 "ga"
  --truncate-result       允许截断超过 20 字的 result（默认拒绝并报错）

Exit codes:
  0  推送成功
  1  推送失败或网络错误（可重试一次）
  2  参数错误（需修正参数后重试）
  3  配置错误（需人工介入）
`);
}

// ── 参数校验 ──────────────────────────────────────────────
const MAX_RESULT_LENGTH = 20;

function validate(args) {
  if (!args.title.trim()) {
    console.error("MISSING_TITLE: --title is required. 请提供任务标题。");
    process.exit(2);
  }
  if (!args.result.trim()) {
    console.error("MISSING_RESULT: --result is required. 请提供短状态文本。");
    process.exit(2);
  }

  // result 长度检查
  const resultText = args.result.trim();
  if (resultText.length > MAX_RESULT_LENGTH) {
    if (args.truncateResult) {
      args.result = resultText.slice(0, MAX_RESULT_LENGTH);
      console.error(`WARNING_RESULT_TRUNCATED: result 从 ${resultText.length} 字截断为 ${MAX_RESULT_LENGTH} 字`);
    } else {
      console.error(
        `RESULT_TOO_LONG: result 当前 ${resultText.length} 字，上限 ${MAX_RESULT_LENGTH} 字。\n` +
        `  请缩短 result 文本，或使用 --truncate-result 允许自动截断。`
      );
      process.exit(2);
    }
  }

  // content 来源
  if (args.contentFile) {
    if (!fs.existsSync(args.contentFile)) {
      console.error(`CONTENT_FILE_NOT_FOUND: ${args.contentFile} 文件不存在。`);
      process.exit(2);
    }
    try {
      args.content = fs.readFileSync(args.contentFile, "utf-8").trim();
    } catch (e) {
      console.error(`CONTENT_FILE_READ_ERROR: ${e.message}`);
      process.exit(2);
    }
    if (!args.content) {
      console.error("CONTENT_EMPTY: 内容文件为空。");
      process.exit(2);
    }
  } else if (args.content) {
    args.content = args.content.trim();
  }
  // content 非必填，可以为空
}

// ── 主流程 ──────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);
  validate(args);

  const authCode = process.env.CYBERBOSS_TODAY_TASK_AUTH_CODE || "";
  const pushUrl = process.env.CYBERBOSS_TODAY_TASK_PUSH_URL || DEFAULT_PUSH_URL;
  const timeoutMs = parseInt(process.env.CYBERBOSS_TODAY_TASK_TIMEOUT_MS, 10) || 30_000;

  if (!authCode) {
    console.error("CONFIG_MISSING_AUTH: CYBERBOSS_TODAY_TASK_AUTH_CODE 未设置。请在 .env 中配置。");
    process.exit(3);
  }

  const svc = new TodayTaskService({
    config: { todayTaskAuthCode: authCode, todayTaskPushUrl: pushUrl, todayTaskTimeoutMs: timeoutMs },
  });

  try {
    const result = await svc.push(
      {
        title: args.title.trim(),
        result: args.result.trim(),
        content: args.content || "",
        taskId: args.taskId.trim() || undefined,
      },
      {
        runtimeId: args.runtimeId.trim() || "cli",
        workspaceRoot: process.cwd(),
      }
    );

    // 成功：输出机器可读 JSON 到 stdout
    console.log(JSON.stringify({ ok: true, taskId: result.taskId, status: result.status }));
  } catch (err) {
    // 区分错误类型
    const msg = err.message || String(err);
    if (msg.includes("abort") || msg.includes("timeout") || msg.includes("fetch") || msg.includes("ECONN")) {
      // 网络类错误
      console.error(`PUSH_NETWORK_ERROR: ${msg}`);
      process.exit(1);
    }
    if (msg.includes("not configured") || msg.includes("auth")) {
      // 配置类错误
      console.error(`PUSH_CONFIG_ERROR: ${msg}`);
      process.exit(3);
    }
    // 其他错误
    console.error(`PUSH_FAILED: ${msg}`);
    process.exit(1);
  }
}

main();
