const fs = require("fs");
const path = require("path");

const BUILDER_PATCH_MARKER = "resolveCyberbossTimelineThemeAssetsDir";
const BUILDER_IMPORT_ANCHOR = 'const { loadTimelineSourceData } = require("./timeline-source-data");';
const BUILDER_PATCH_INSERT = `${BUILDER_IMPORT_ANCHOR}

function resolveCyberbossTimelineThemeAssetsDir() {
  const theme = normalizeText(process.env.CYBERBOSS_TIMELINE_UI_THEME || process.env.CYBERBOSS_TIMELINE_THEME).toLowerCase();
  if (!theme || theme === "default" || theme === "upstream" || theme === "timeline-for-agent") {
    return "";
  }

  if (theme === "custom") {
    const configured = normalizeText(process.env.CYBERBOSS_TIMELINE_CUSTOM_ASSETS_DIR);
    return configured && hasCyberbossTimelineDashboardAssets(configured) ? configured : "";
  }

  if (theme !== "neko" && theme !== "boss") {
    return "";
  }

  const candidate = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "src",
    "integrations",
    "timeline",
    "custom-dashboard-assets"
  );
  return hasCyberbossTimelineDashboardAssets(candidate) ? candidate : "";
}

function hasCyberbossTimelineDashboardAssets(dir) {
  return fs.existsSync(path.join(dir, "dashboard.js")) && fs.existsSync(path.join(dir, "dashboard.css"));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}`;
const BUILDER_BLOCK_OLD = `  await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    outfile: path.join(assetsDir, "dashboard.js"),
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: {
      ".jsx": "jsx",
      ".css": "css",
    },
    external: [],
    logLevel: "silent",
    target: ["chrome120", "safari17"],
  });

  const bundledCssPath = path.join(assetsDir, "dashboard.css");
  if (!fs.existsSync(bundledCssPath)) {
    fs.copyFileSync(cssFile, bundledCssPath);
  }`;
const BUILDER_BLOCK_NEW = `  const bundledJsPath = path.join(assetsDir, "dashboard.js");
  const bundledCssPath = path.join(assetsDir, "dashboard.css");

  const themeAssetsDir = resolveCyberbossTimelineThemeAssetsDir();
  if (themeAssetsDir) {
    fs.copyFileSync(path.join(themeAssetsDir, "dashboard.js"), bundledJsPath);
    fs.copyFileSync(path.join(themeAssetsDir, "dashboard.css"), bundledCssPath);
  } else {
    await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      outfile: bundledJsPath,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      loader: {
        ".jsx": "jsx",
        ".css": "css",
      },
      external: [],
      logLevel: "silent",
      target: ["chrome120", "safari17"],
    });

    if (!fs.existsSync(bundledCssPath)) {
      fs.copyFileSync(cssFile, bundledCssPath);
    }
  }`;
const LEGACY_RMSYNC_BLOCK = `  fs.rmSync(bundledJsPath, { force: true });
  fs.rmSync(bundledCssPath, { force: true });

`;

function main() {
  const targetPath = path.join(
    __dirname,
    "..",
    "node_modules",
    "timeline-for-agent",
    "src",
    "infra",
    "timeline",
    "timeline-dashboard-builder.js"
  );

  if (!fs.existsSync(targetPath)) {
    console.log("[postinstall] timeline theme patch skipped: target file not found");
    return;
  }

  const original = fs.readFileSync(targetPath, "utf8");
  if (original.includes(BUILDER_PATCH_MARKER)) {
    if (original.includes(LEGACY_RMSYNC_BLOCK)) {
      fs.writeFileSync(targetPath, original.replace(LEGACY_RMSYNC_BLOCK, ""), "utf8");
      console.log("[postinstall] updated timeline theme patch for Windows overwrite");
      return;
    }
    console.log("[postinstall] timeline theme patch already applied");
    return;
  }
  if (!original.includes(BUILDER_IMPORT_ANCHOR) || !original.includes(BUILDER_BLOCK_OLD)) {
    console.log("[postinstall] timeline theme patch skipped: source signature changed");
    return;
  }

  let patched = original.replace(BUILDER_IMPORT_ANCHOR, BUILDER_PATCH_INSERT);
  patched = patched.replace(BUILDER_BLOCK_OLD, BUILDER_BLOCK_NEW);
  fs.writeFileSync(targetPath, patched, "utf8");
  console.log("[postinstall] patched timeline-for-agent theme assets");
}

main();
