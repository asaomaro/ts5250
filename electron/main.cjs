// AS400 5250 エミュレーター — Electron メインプロセス
//   既存の Hono サーバー（packages/server）を Electron 内で起動し（TN5250 接続は Node が担う）、
//   ビルド済み Web UI を BrowserWindow で開く。単一プロセス構成。
"use strict";
const { app, BrowserWindow, shell, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { pathToFileURL } = require("node:url");

/**
 * アプリのルート（＝サーバーを動かす cwd）。serveStatic は cwd 相対で解決するので cwd を合わせる。
 *
 * **開発時と配布時でレイアウトが違う。**
 *  - 開発: repo ルート。サーバーは `packages/server/dist/main.js`、依存は repo の node_modules
 *  - 配布: `resources/app`（`scripts/prepare-app.mjs` が組んだ一式）。サーバーは
 *    `node_modules/@as400web/server/dist/main.js`、依存も同じ node_modules に入っている
 *
 * 以前は配布時も `resources` を指しており、実際の配置（`resources/app/...`）と 1 階層ずれていた。
 * さらに実行時依存を同梱していなかったため、**出来上がった exe は起動できなかった**。
 */
const ROOT = app.isPackaged ? path.join(process.resourcesPath, "app") : path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 3400);
const WEB_ROOT = "packages/web-ui/dist"; // cwd(ROOT) 相対
const SERVER_MAIN = app.isPackaged
  ? path.join(ROOT, "node_modules", "@as400web", "server", "dist", "main.js")
  : path.join(ROOT, "packages", "server", "dist", "main.js");
const APP_URL = `http://127.0.0.1:${PORT}/`;

/** 指定した .env を読み込み process.env に反映（プロファイルの passwordEnv・master key 等） */
function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

/**
 * 書き込みが必要な状態ファイル（.env / connections.json / 編集可能な profiles.json）の置き場所を決める。
 * パッケージ配布では app ディレクトリ（asar）が読み取り専用なので userData を使う。開発時は repo ルート。
 */
function resolveDataDir() {
  const dir = app.isPackaged ? app.getPath("userData") : ROOT;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * プロファイルファイルのパスを解決する。
 * 開発時: repo ルートの profiles.local.json / profiles.json（従来どおり・相対）。
 * パッケージ時: userData の profiles.json。編集して永続化できる。
 *
 * **配布物にはサーバー設定を同梱しない**（`prepare-app.mjs` が `app-stage` へ入れない）。
 * ビルドした人の接続先・資格情報がそのまま配られてしまうため。利用者は起動後に自分で作る。
 */
function resolveProfiles(dataDir) {
  if (dataDir === ROOT) {
    for (const f of ["profiles.local.json", "profiles.json"]) {
      if (fs.existsSync(path.join(ROOT, f))) return f;
    }
    return undefined;
  }
  const dest = path.join(dataDir, "profiles.json");
  if (!fs.existsSync(dest)) {
    for (const f of ["profiles.local.json", "profiles.json"]) {
      const src = path.join(ROOT, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        break;
      }
    }
  }
  return fs.existsSync(dest) ? dest : undefined;
}

/** /healthz が 200 を返すまで待つ */
function waitForHealth(port, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/healthz" }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on("error", retry);
      req.setTimeout(1000, () => req.destroy());
      function retry() {
        if (Date.now() - start > timeoutMs) reject(new Error("server did not become healthy in time"));
        else setTimeout(tick, 400);
      }
    };
    tick();
  });
}

/** 既存サーバー main() を http モードで起動する */
async function startServer() {
  if (!fs.existsSync(SERVER_MAIN)) {
    throw new Error(`サーバーが未ビルドです: ${SERVER_MAIN}\n先に 'npm run build' と web-ui の 'vite build' を実行してください。`);
  }
  process.chdir(ROOT); // serveStatic（--web-root）は cwd 相対で読み取り専用アセットを解決する
  const dataDir = resolveDataDir();
  const envPath = path.join(dataDir, ".env");
  loadDotEnv(envPath);
  // パッケージ時は repo ルートの .env も一応読む（開発用 .env が同梱されていれば passwordEnv 等を拾える）
  if (dataDir !== ROOT) loadDotEnv(path.join(ROOT, ".env"));

  const argv = ["--http", String(PORT), "--web-root", WEB_ROOT];
  const profiles = resolveProfiles(dataDir);
  if (profiles) argv.push("--profiles", profiles);
  // 書き込みが要る状態は userData（パッケージ時）へ。ユーザー接続（暗号化パスワード含む）と master key を保存する
  argv.push("--connections", path.join(dataDir, "connections.json"));
  // 単一利用者アプリなので master key が無ければ自動生成して .env に保存（次回起動で loadDotEnv が拾う）
  argv.push("--auto-secret-key", "--secret-key-file", envPath);
  const mod = await import(pathToFileURL(SERVER_MAIN).href);
  await mod.main(argv); // serve() は非ブロッキング。listen 開始後に resolve
  await waitForHealth(PORT);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "AS400 5250 エミュレーター",
    backgroundColor: "#0b0f0b",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  // 外部リンク（画面テキストのリンク化）は既定ブラウザで開く
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.loadURL(APP_URL);
  return win;
}

app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (err) {
    const { dialog } = require("electron");
    dialog.showErrorBox("起動エラー", String(err && err.message ? err.message : err));
    app.quit();
    return;
  }
  Menu.setApplicationMenu(null);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // サーバーは同一プロセスなので終了で片付く
  if (process.platform !== "darwin") app.quit();
});
