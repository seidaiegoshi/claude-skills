#!/usr/bin/env node
// 完了報告に貼る画面キャプチャを PNG ファイルに保存する。
// ブラウザ系 MCP の screenshot はモデルに返るだけでファイルにならず、Artifact に埋め込めないため。
//
// 使い方（プロジェクトの node_modules がある場所で実行する）:
//   node capture.cjs --base http://localhost:8002 --out-dir /tmp/shots \
//     --storage-state .auth/admin.json --shot orders:/orders --shot 在庫:/stocks

const fs = require("node:fs");
const path = require("node:path");

function loadPlaywright() {
  const paths = [process.cwd(), path.join(process.cwd(), "e2e"), path.join(process.cwd(), "..", "e2e")];
  for (const name of ["@playwright/test", "playwright"]) {
    try {
      return require(require.resolve(name, { paths }));
    } catch {}
  }
  throw new Error(`playwright が見つからない。探した場所: ${paths.join(", ")}`);
}

const argv = process.argv.slice(2);
const opt = (key, fallback) => {
  const i = argv.indexOf(`--${key}`);
  return i === -1 ? fallback : argv[i + 1];
};
const many = (key) => argv.flatMap((v, i) => (v === `--${key}` ? [argv[i + 1]] : []));
const flag = (key) => argv.includes(`--${key}`);

// Vite dev server は HMR の WebSocket を開き続けるため networkidle は永遠に来ない
const GOTO = { waitUntil: "load" };

async function settle(page, waitFor, waitMs) {
  if (waitFor) await page.locator(waitFor).first().waitFor({ state: "visible" });
  await page.waitForTimeout(waitMs);
}

async function login(page, base, loginPath, email, password) {
  await page.goto(base + loginPath, GOTO);
  await page.locator('input[type="email"], input[name="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.locator('button[type="submit"]').first().click();
  await page.locator('input[type="password"]').first().waitFor({ state: "detached" });
}

(async () => {
  const { chromium } = loadPlaywright();
  const base = String(opt("base", "http://localhost:8000")).replace(/\/$/, "");
  const outDir = opt("out-dir", process.cwd());
  const storageState = opt("storage-state");
  const email = opt("email");
  const waitMs = Number(opt("wait-ms", 800));
  const shots = many("shot");

  if (shots.length === 0) throw new Error("--shot ラベル:/パス を1つ以上渡す");
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: Number(opt("width", 1440)), height: Number(opt("height", 900)) },
    // 埋め込み時に縮小するので、2倍で撮っておかないと文字が潰れる
    deviceScaleFactor: 2,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    colorScheme: opt("color-scheme", "light"),
    storageState: storageState && fs.existsSync(storageState) ? storageState : undefined,
  });
  const page = await context.newPage();

  if (email) await login(page, base, opt("login-path", "/"), email, opt("password", ""));
  await settle(page, null, waitMs);
  const saveState = opt("save-state");
  if (saveState) await context.storageState({ path: saveState });

  for (const shot of shots) {
    const sep = shot.indexOf(":");
    const label = shot.slice(0, sep);
    const target = shot.slice(sep + 1);
    const url = /^[a-z]+:\/\//i.test(target) ? target : base + target;
    await page.goto(url, GOTO);
    await settle(page, opt("wait-for"), waitMs);
    const out = path.join(outDir, `${label}.png`);
    await page.screenshot({ path: out, fullPage: flag("full-page") });
    console.log(`${out}\t${url}\t${(fs.statSync(out).size / 1024).toFixed(0)}KB`);
  }

  await browser.close();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
