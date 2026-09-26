import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ServiceManager } from "./serviceManager.js";
import { ExtensionSecretCrypto } from "./secretCrypto.js";
import { Ts5250EditorProvider } from "./ts5250EditorProvider.js";
import { syncSystem } from "./systemSync.js";

/**
 * サーバー本体・web-uiの静的アセットの場所を、dev/packagedで出し分ける
 * （`electron/main.cjs`の`ROOT`分岐と同じ役割）。
 *
 * - **`Development`**（`--extensionDevelopmentPath`起動）: このファイルは
 *   `<repo>/vscode-extension/dist/extension.js`にコンパイルされる——
 *   `context.extensionUri`は`<repo>/vscode-extension`を指すので、1階層上が
 *   リポジトリルート。`packages/server/dist`・`packages/web-ui/dist`を直接使う
 * - **`Production`**（`.vsix`をインストールして起動）: `vscode-extension/
 *   scripts/prepare-server.mjs`が作る`server-stage/`が、拡張機能自身の
 *   ディレクトリ（`context.extensionUri`）に同梱されている
 *   （`04-packaging/tasks.md`「実装方針」2）
 *
 * **`Production`分岐はVSCode拡張ホストの実地確認ができていない**——このコンテナには
 * `--extensionDevelopmentPath`/`.vsix`インストールを駆動できる環境が無い
 * （`02-extension-core`「未検証の穴」と同じ制約）。`server-stage/`のレイアウト自体は
 * 実際に`node`で直接起動して確認済み（`04-packaging/test-result.md`）
 */
function resolveServerPaths(context: vscode.ExtensionContext): { serverMainPath: string; webRootPath: string } {
  if (context.extensionMode === vscode.ExtensionMode.Production) {
    const stage = join(context.extensionUri.fsPath, "server-stage");
    return {
      serverMainPath: join(stage, "node_modules", "@ts5250", "server", "dist", "main.js"),
      webRootPath: join(stage, "packages", "web-ui", "dist")
    };
  }
  const root = join(context.extensionUri.fsPath, "..");
  return {
    serverMainPath: join(root, "packages", "server", "dist", "main.js"),
    webRootPath: join(root, "packages", "web-ui", "dist")
  };
}

/** ハートビートの間隔（design.md「振る舞いの詳細」の調停プロトコル） */
const HEARTBEAT_INTERVAL_MS = 30_000;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const { serverMainPath, webRootPath } = resolveServerPaths(context);
  const globalStorageDir = context.globalStorageUri.fsPath;
  // **`globalStorageUri`は物理的に存在する保証が無い**（初回インストール直後は
  // まだ誰も書き込んでいない）。ここで作らずに済ませていたため、`ServiceManager`の
  // ロックファイル書き込み自体は`writeLock()`内で`mkdirSync`していて無事だったが、
  // **別プロセス**として`spawn`する`packages/server`側が`--secret-key-file`
  // （`.env`）や`--connections`へ書き込む際は親ディレクトリを作らず、実機（Windows）で
  // `ENOENT: ...\globalStorage\...\.env`という起動失敗を起こした。ここで一括して
  // 用意しておく（spawnする前に必ず存在させる）
  mkdirSync(globalStorageDir, { recursive: true });

  // **子プロセスのstdout/stderrをここへ流す**（design.md「ログ」）。GUIアプリには
  // stderrを読む人がいないので、起動状況をVSCode側に残す（`electron/main.cjs`の
  // `startupLog`と同じ動機）
  const output = vscode.window.createOutputChannel("ts5250");
  context.subscriptions.push(output);

  const serviceManager = new ServiceManager({
    lockFilePath: join(globalStorageDir, "service.json"),
    serverMainPath,
    webRootPath,
    connectionsPath: join(globalStorageDir, "connections.json"),
    secretKeyFilePath: join(globalStorageDir, ".env"),
    windowId: randomUUID(),
    // spawn直後、成否が分かる前から流す（`serviceManager.ts`の`onChildOutput`コメント参照）。
    // 以前はここ（`acquire()`が返した後）でしか配線しておらず、起動に失敗したときの
    // 診断出力が失われていた
    onChildOutput: (chunk) => output.append(chunk)
  });

  /**
   * **ウィンドウ内のローカル参照カウント**（`decisions.md` D1）。`ServiceManager`の
   * `windows`（ロックファイル）はウィンドウ単位の1エントリなので、同じウィンドウで
   * 複数の`.ts5250`パネルを開いたとき、2つ目以降の`acquire()`は既存エントリの
   * タイムスタンプを更新するだけで増えない——**素朴にパネルごとへ`release()`を
   * 中継すると、1つ目のパネルを閉じた時点で他のパネルがまだ使っているのに
   * ウィンドウのエントリごと消える**。ここでローカルに数えてから中継することで防ぐ
   */
  let localCount = 0;
  const acquireService = async (): Promise<{ port: number }> => {
    localCount++;
    try {
      // 子プロセスのstdout/stderrは`ServiceManager`が`onChildOutput`経由で
      // spawn直後から流す（成否が分かる前から。失敗時の診断出力を失わないため）
      const result = await serviceManager.acquire();
      return { port: result.port };
    } catch (e) {
      // **起動に失敗したら数えたことにしない。** 増やしたまま呼び出し元（Ts5250EditorProvider）が
      // 失敗時にreleaseServiceを呼ばない経路を通ると、localCountが下がらないまま残り、
      // 以後どのパネルを閉じても`localCount === 0`に到達せず実体のプロセスが永久に
      // 止まらなくなる（unit testで実際に踏んだ）
      localCount--;
      throw e;
    }
  };
  const releaseService = async (): Promise<void> => {
    // **対応するacquireが無い呼び出しは無視する。** ここで無条件に
    // `Math.max(0, localCount - 1)`してから0判定すると、「既に0だった」場合も
    // 「1から0になった」場合と区別が付かず、余分に`serviceManager.release()`を
    // 呼んでしまう（unit testで実際に踏んだ）
    if (localCount === 0) return;
    localCount--;
    if (localCount === 0) await serviceManager.release();
  };

  const heartbeat = setInterval(() => {
    if (localCount > 0) void serviceManager.heartbeat();
  }, HEARTBEAT_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(heartbeat) });

  const secretCrypto = await ExtensionSecretCrypto.fromSecretStorage(context.secrets);
  const systemRefsPath = join(globalStorageDir, "systemRefs.json");
  const provider = new Ts5250EditorProvider({
    secretCrypto,
    acquireService,
    releaseService,
    // スプール/sql/ifs用（03-sql-ifs）。ローカルサーバーのportは
    // 呼び出し側（Ts5250EditorProvider）が`acquireService()`の結果から都度渡す
    syncSystem: (localPort, input) => syncSystem(input, { port: localPort, mappingFilePath: systemRefsPath }),
    log: (message) => output.appendLine(message)
  });

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(Ts5250EditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push({
    dispose: () => {
      // **ベストエフォート**——通常は各パネルのonDidDisposeが先に走ってlocalCountは
      // 既に0になっているはずだが、VSCode終了時の順序は保証されないため保険を置く
      if (localCount > 0) void serviceManager.release();
    }
  });
}

export function deactivate(): void {
  /* 後片付けは`context.subscriptions`に登録済み（VSCodeが拡張の無効化時に順にdisposeする） */
}
