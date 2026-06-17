const qrcodeTerminal = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const QRCode = require("qrcode-terminal/vendor/QRCode");
const QRErrorCorrectLevel = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");
const {
  deleteWeixinAccount,
  listWeixinAccounts,
  saveWeixinAccount,
} = require("./account-store");
const { clearPersistedContextTokens } = require("./context-token-store");
const { redactSensitiveText } = require("./redact");

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH_COUNT = 3;
const LOGIN_QR_PAGE_NAME = "login-qrcode.html";

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

async function fetchQrCode(apiBaseUrl, botType) {
  const base = ensureTrailingSlash(apiBaseUrl);
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base);
  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`Failed to fetch QR code: ${response.status} ${response.statusText} ${redactSensitiveText(body)}`);
  }
  return response.json();
}

async function pollQrStatus(apiBaseUrl, qrcode) {
  const base = ensureTrailingSlash(apiBaseUrl);
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: {
        "iLink-App-ClientVersion": "1",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`QR status polling failed: ${response.status} ${response.statusText} ${redactSensitiveText(rawText)}`);
    }
    return JSON.parse(rawText);
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "wait" };
    }
    throw error;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildQrSvg(content) {
  const qrcode = new QRCode(-1, QRErrorCorrectLevel.L);
  qrcode.addData(content);
  qrcode.make();

  const moduleCount = qrcode.getModuleCount();
  const quietZone = 4;
  const cellSize = 10;
  const size = (moduleCount + quietZone * 2) * cellSize;
  const rects = [];
  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      if (qrcode.modules[row][col]) {
        rects.push(`<rect x="${(col + quietZone) * cellSize}" y="${(row + quietZone) * cellSize}" width="${cellSize}" height="${cellSize}"/>`);
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="420" height="420" role="img" aria-label="WeChat login QR code">`,
    `<rect width="100%" height="100%" fill="#fff"/>`,
    `<g fill="#000">${rects.join("")}</g>`,
    `</svg>`,
  ].join("");
}

function writeQrCodePage({ stateDir, content }) {
  if (!stateDir) {
    return "";
  }
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = path.join(stateDir, LOGIN_QR_PAGE_NAME);
  const escapedContent = escapeHtml(content);
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CyberBoss WeChat Login QR</title>
  <style>
    html, body { margin: 0; min-height: 100%; font-family: Segoe UI, Microsoft YaHei, Arial, sans-serif; background: #f6f7f9; color: #111827; }
    main { min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
    section { text-align: center; max-width: 560px; }
    .qr { display: inline-block; padding: 18px; background: #fff; border: 1px solid #d1d5db; }
    h1 { font-size: 22px; margin: 0 0 16px; font-weight: 650; }
    p { margin: 14px 0 0; line-height: 1.5; color: #374151; }
    a { color: #2563eb; word-break: break-all; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>CyberBoss WeChat Login</h1>
      <div class="qr">${buildQrSvg(content)}</div>
      <p>Use WeChat to scan this QR code. Keep the login command window open until login succeeds.</p>
      <p><a href="${escapedContent}">${escapedContent}</a></p>
    </section>
  </main>
</body>
</html>`;
  fs.writeFileSync(filePath, html, "utf8");
  return filePath;
}

function shouldOpenQrCodePage() {
  const configured = String(process.env.CYBERBOSS_LOGIN_QR_BROWSER || "").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(configured)) {
    return false;
  }
  if (["1", "true", "yes", "on"].includes(configured)) {
    return true;
  }
  return process.platform === "win32" && !process.env.WT_SESSION && !process.env.CI;
}

function openFileInBrowser(filePath) {
  if (!filePath) {
    return;
  }
  try {
    if (process.platform === "win32") {
      const child = spawn("cmd.exe", ["/c", "start", "", filePath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return;
    }
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(opener, [filePath], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // The file path is still printed below as a manual fallback.
  }
}

function printQrCode(url, options = {}) {
  try {
    qrcodeTerminal.generate(url, { small: true });
  } catch {
    console.log(url);
  }

  let qrPagePath = "";
  try {
    qrPagePath = writeQrCodePage({ stateDir: options.stateDir, content: url });
    if (shouldOpenQrCodePage()) {
      openFileInBrowser(qrPagePath);
      console.log("Opened a browser QR page for Windows console users.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[cyberboss] could not write browser QR page: ${message}`);
  }

  console.log("If the QR code does not render correctly here, open this link or QR page in a browser and scan it there:");
  if (qrPagePath) {
    console.log(qrPagePath);
  }
  console.log(url);
}

function cleanupStaleAccountsForUserId(config, activeAccount) {
  const activeUserId = typeof activeAccount?.userId === "string" ? activeAccount.userId.trim() : "";
  if (!activeUserId) {
    return [];
  }
  const staleAccounts = listWeixinAccounts(config).filter((account) => (
    account.accountId !== activeAccount.accountId
    && typeof account.userId === "string"
    && account.userId.trim() === activeUserId
  ));
  for (const staleAccount of staleAccounts) {
    deleteWeixinAccount(config, staleAccount.accountId);
    clearPersistedContextTokens(config, staleAccount.accountId);
    console.log(`[cyberboss] removed stale account ${staleAccount.accountId} for userId ${activeUserId}`);
  }
  return staleAccounts;
}

async function waitForWeixinLogin({ apiBaseUrl, botType, timeoutMs, stateDir }) {
  let qrResponse = await fetchQrCode(apiBaseUrl, botType);
  let startedAt = Date.now();
  let scannedPrinted = false;
  let refreshCount = 1;

  console.log("Scan this QR code with WeChat to connect:\n");
  printQrCode(qrResponse.qrcode_img_content, { stateDir });
  console.log("\nWaiting for the connection result...\n");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (Date.now() - startedAt > ACTIVE_LOGIN_TTL_MS) {
      qrResponse = await fetchQrCode(apiBaseUrl, botType);
      startedAt = Date.now();
      scannedPrinted = false;
      refreshCount += 1;
      if (refreshCount > MAX_QR_REFRESH_COUNT) {
        throw new Error("The QR code expired too many times. Run login again.");
      }
      console.log(`QR code expired. Refreshing... (${refreshCount}/${MAX_QR_REFRESH_COUNT})\n`);
      printQrCode(qrResponse.qrcode_img_content, { stateDir });
    }

    const statusResponse = await pollQrStatus(apiBaseUrl, qrResponse.qrcode);
    switch (statusResponse.status) {
      case "wait":
        process.stdout.write(".");
        break;
      case "scaned":
        if (!scannedPrinted) {
          process.stdout.write("\nQR code scanned. Confirm the login inside WeChat...\n");
          scannedPrinted = true;
        }
        break;
      case "expired":
        qrResponse = await fetchQrCode(apiBaseUrl, botType);
        startedAt = Date.now();
        scannedPrinted = false;
        refreshCount += 1;
        if (refreshCount > MAX_QR_REFRESH_COUNT) {
          throw new Error("The QR code expired too many times. Run login again.");
        }
        console.log(`QR code expired. Refreshing... (${refreshCount}/${MAX_QR_REFRESH_COUNT})\n`);
        printQrCode(qrResponse.qrcode_img_content, { stateDir });
        break;
      case "confirmed":
        if (!statusResponse.bot_token || !statusResponse.ilink_bot_id) {
          throw new Error("Login succeeded but the response is missing the bot token or account ID.");
        }
        return {
          accountId: statusResponse.ilink_bot_id,
          token: statusResponse.bot_token,
          baseUrl: statusResponse.baseurl || apiBaseUrl,
          userId: statusResponse.ilink_user_id || "",
        };
      default:
        break;
    }
  }
  throw new Error("Login timed out. Run login again.");
}

async function runLoginFlow(config) {
  console.log("[cyberboss] starting WeChat QR login...");
  const result = await waitForWeixinLogin({
    apiBaseUrl: config.weixinBaseUrl,
    botType: config.weixinQrBotType,
    timeoutMs: 480_000,
    stateDir: config.stateDir,
  });
  const account = saveWeixinAccount(config, result.accountId, result);
  cleanupStaleAccountsForUserId(config, account);
  console.log("\n✅ Connected to WeChat successfully.");
  console.log(`accountId: ${account.accountId}`);
  console.log(`userId: ${account.userId || "(unknown)"}`);
  console.log(`baseUrl: ${account.baseUrl}`);
}

module.exports = { runLoginFlow };
