// AS400 5250 エミュレーター — Electron メインプロセス
//   既存の Hono サーバー（packages/server）を Electron 内で起動し（TN5250 接続は Node が担う）、
//   ビルド済み Web UI を BrowserWindow で開く。単一プロセス構成。
"use strict";
const { app, BrowserWindow, shell, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
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
const WEB_ROOT = "packages/web-ui/dist"; // cwd(ROOT) 相対
const SERVER_MAIN = app.isPackaged
  ? path.join(ROOT, "node_modules", "@as400web", "server", "dist", "main.js")
  : path.join(ROOT, "packages", "server", "dist", "main.js");

/**
 * 起動の記録（userData/startup.log）。
 *
 * **GUI アプリには stderr を読む人がいない。** 起動に失敗しても「ダブルクリックしても何も出ない」
 * としか分からず、手掛かりが残らない。どこまで進んだかをファイルに残しておく。
 * 毎回上書きなので溜まらない。
 */
let logPath;
function startupLog(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stderr.write(line);
  try {
    if (logPath) fs.appendFileSync(logPath, line);
  } catch {
    /* ログが書けないこと自体で起動を止めない */
  }
}

/**
 * 空いている TCP ポートを探す（127.0.0.1）。
 *
 * **3400 を決め打ちにしない。** 開発用の `start.sh` / `start.bat` を動かしたままだったり、
 * 前回の起動が終了しきれずに残っていたりすると、この 1 点で起動できなくなる。
 * サーバーは listen に失敗しても main() が resolve してしまうので、**先に空きを確かめる**。
 */
function findFreePort(start, attemptsLeft = 20) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => {
      if (attemptsLeft <= 0) reject(new Error(`空きポートが見つかりません（${start} から探索）`));
      else resolve(findFreePort(start + 1, attemptsLeft - 1));
    });
    probe.listen(start, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

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

/** 既存サーバー main() を http モードで起動し、待ち受けたポートを返す */
async function startServer() {
  startupLog(`root=${ROOT}`);
  startupLog(`server=${SERVER_MAIN}`);
  if (!fs.existsSync(SERVER_MAIN)) {
    throw new Error(`サーバー本体が見つかりません:\n${SERVER_MAIN}`);
  }
  process.chdir(ROOT); // serveStatic（--web-root）は cwd 相対で読み取り専用アセットを解決する
  const dataDir = resolveDataDir();
  const envPath = path.join(dataDir, ".env");
  loadDotEnv(envPath);
  // パッケージ時は repo ルートの .env も一応読む（開発用 .env が同梱されていれば passwordEnv 等を拾える）
  if (dataDir !== ROOT) loadDotEnv(path.join(ROOT, ".env"));

  const port = Number(process.env.PORT) || (await findFreePort(3400));
  startupLog(`port=${port}`);
  const argv = ["--http", String(port), "--web-root", WEB_ROOT];
  const profiles = resolveProfiles(dataDir);
  if (profiles) argv.push("--profiles", profiles);
  // 書き込みが要る状態は userData（パッケージ時）へ。ユーザー接続（暗号化パスワード含む）と master key を保存する
  argv.push("--connections", path.join(dataDir, "connections.json"));
  // 単一利用者アプリなので master key が無ければ自動生成して .env に保存（次回起動で loadDotEnv が拾う）
  argv.push("--auto-secret-key", "--secret-key-file", envPath);
  const mod = await import(pathToFileURL(SERVER_MAIN).href);
  startupLog("server module loaded");
  await mod.main(argv); // serve() は非ブロッキング。listen 開始後に resolve
  await waitForHealth(port);
  startupLog("server healthy");
  return port;
}

/** 内蔵サーバーが立つ前でも見せられる 1 枚もの（起動中 / 失敗）。 */
function statusPage(title, body) {
  const esc = (s) =>
    String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<style>
 body{margin:0;height:100vh;display:flex;flex-direction:column;justify-content:center;
      align-items:center;gap:14px;background:#0b0f0b;color:#d9e3da;
      font-family:system-ui,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif}
 h1{font-size:15px;font-weight:600;margin:0;color:#3ddc84}
 pre{margin:0;max-width:80ch;white-space:pre-wrap;word-break:break-all;
     font-size:12px;line-height:1.6;color:#8fa093;text-align:left}
</style>
<h1>${esc(title)}</h1><pre>${esc(body)}</pre>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

let mainWindow = null;

/**
 * ウィンドウは**サーバーより先に開く**。
 *
 * 以前は起動が終わってから開いていたので、途中で失敗すると**画面に何も出ないまま**だった
 * （プロセスだけ残る）。GUI アプリでは stderr を読む人がいないので、
 * 状態はウィンドウに出す。失敗しても閉じずに理由とログの場所を残す。
 */
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
  win.loadURL(statusPage("起動しています…", "内蔵サーバーの準備中です。"));
  return win;
}

// **二重起動を防ぐ。** portable exe は毎回展開するので、気づかず 2 つ動かすと
// 片方がポートを掴んだまま無反応に見える。2 つ目は既存のウィンドウを前面に出して終わる。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // ログの置き場は userData（app.getPath は whenReady 後に確定する）
    try {
      const dir = app.getPath("userData");
      fs.mkdirSync(dir, { recursive: true });
      logPath = path.join(dir, "startup.log");
      fs.writeFileSync(logPath, "");
    } catch {
      /* 書けなければ stderr だけ */
    }
    startupLog(`starting (packaged=${app.isPackaged}, platform=${process.platform})`);

    mainWindow = createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });

    try {
      const port = await startServer();
      mainWindow.loadURL(`http://127.0.0.1:${port}/`);
    } catch (err) {
      const detail = err && err.stack ? err.stack : String(err);
      startupLog(`failed: ${detail}`);
      mainWindow.loadURL(
        statusPage(
          "起動できませんでした",
          `${err && err.message ? err.message : String(err)}\n\n` +
            `詳しい記録: ${logPath ?? "(書き出せませんでした)"}`
        )
      );
    }
  });
}

app.on("window-all-closed", () => {
  // サーバーは同一プロセスなので終了で片付く
  if (process.platform !== "darwin") app.quit();
});
