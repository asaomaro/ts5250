import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import * as vscode from "vscode";
import { parseTs5250File, stringifyTs5250File, type Ts5250File } from "./schema.js";
import { buildShellHtml } from "./webviewHtml.js";
import type { ExtensionSecretCrypto } from "./secretCrypto.js";
import type { SystemSyncInput } from "./systemSync.js";
import type { ConnectPayload, HostToWebviewMessage, SettingsFormValues, WebviewToHostMessage } from "./protocol.js";

/**
 * `.ts5250`のCustom Text Editor。design.md「振る舞いの詳細」の各シーケンス図を実装する。
 *
 * **ウィンドウ内の参照カウントは知らない**——`acquireService`/`releaseService`を
 * 関数として受け取るだけ（`decisions.md` D1）。実体（ローカルカウント＋
 * `ServiceManager`）は`extension.ts`が組み立てる
 */
export interface Ts5250EditorProviderDeps {
  secretCrypto: ExtensionSecretCrypto;
  acquireService: () => Promise<{ port: number }>;
  releaseService: () => Promise<void>;
  /**
   * `app !== "emulator"`のときだけ使う（03-sql-ifs）。spawnしたサーバーのポートは
   * `acquireService()`が解決するまで分からないため、呼び出し側が都度渡す
   */
  syncSystem: (localPort: number, input: SystemSyncInput) => Promise<string>;
  /** 診断用ログ（design.md「ログ」）。失敗してもWebViewの表示は止めない経路で使う */
  log: (message: string) => void;
}

export class Ts5250EditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = "ts5250.editor";

  constructor(private readonly deps: Ts5250EditorProviderDeps) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = { enableScripts: true };

    let port: number;
    try {
      ({ port } = await this.deps.acquireService());
    } catch (e) {
      webviewPanel.webview.html = failureHtml(e instanceof Error ? e.message : String(e));
      return;
    }

    const parsed = parseTs5250File(document.getText());
    const nonce = randomBytes(16).toString("hex");
    webviewPanel.webview.html = buildShellHtml({
      port,
      appKind: parsed.ok ? parsed.file.app : "emulator",
      nonce
    });

    const sub = webviewPanel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const msg = raw as WebviewToHostMessage;
      if (!msg || typeof msg !== "object" || !("type" in msg)) return;
      if (msg.type === "ready") {
        await sendConnect(webviewPanel.webview, document, port, this.deps);
      } else if (msg.type === "save") {
        // **形（shape）を見てから渡す。** `postMessage`の中身はWebView側のJSが組み立てた
        // ものなので、型定義（`WebviewToHostMessage`）と一致する保証は無い。`values.host`に
        // 触る`handleSave`より前に、最低限`payload`がオブジェクトで`host`が文字列であることを
        // 確かめる——確かめずに渡すと`null`等で例外を投げ、`onDidReceiveMessage`へ渡した
        // async関数の戻り値（誰も待っていない）が未処理rejectionになる（taskcheck T9の指摘）
        if (!isSettingsFormValues(msg.payload)) {
          post(webviewPanel.webview, { type: "saveError", message: "保存内容の形式が不正です。" });
        } else {
          await handleSave(webviewPanel.webview, document, port, msg.payload, this.deps);
        }
      } else if (msg.type === "openExternal") {
        try {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        } catch {
          /* 不正なURLは黙って無視（画面内リンクの誤クリック程度なので致命ではない） */
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      sub.dispose();
      void this.deps.releaseService();
    });
  }
}

/** `HostToWebviewMessage`の型ガード無しで送る内部ヘルパー（送信側は型で保証されている） */
function post(webview: vscode.Webview, msg: HostToWebviewMessage): void {
  void webview.postMessage(msg);
}

/** `SettingsFormValues`の最低限の形を確かめる（`host`が必須・文字列） */
function isSettingsFormValues(v: unknown): v is SettingsFormValues {
  return typeof v === "object" && v !== null && typeof (v as { host?: unknown }).host === "string";
}

/** `.ts5250`をパースし、パスワードを復号して`connect`メッセージを送る */
async function sendConnect(
  webview: vscode.Webview,
  document: vscode.TextDocument,
  localPort: number,
  deps: Ts5250EditorProviderDeps
): Promise<void> {
  const parsed = parseTs5250File(document.getText());
  if (!parsed.ok) {
    post(webview, { type: "fileInvalid", message: parsed.error });
    return;
  }
  const payload = await resolvePayload(parsed.file, document, localPort, deps);
  post(webview, { type: "connect", payload });
}

/**
 * `Ts5250File` → `ConnectPayload`（直接接続用のフィールド解決）＋`systemRef`の解決
 * （`syncSystem`でサーバーへ個人設定を登録・同期する。`03-sql-ifs`。design.md
 * 「設計方針3」訂正後）を**全app種別に**上乗せする。
 *
 * **emulatorとそれ以外でsystemRefの使いみちが違う**（design.md訂正後・利用者要望で
 * emulatorにも拡張。`decisions.md` D12）:
 * - emulator: `buildConnectPayload`の`user`/`password`は**そのまま残す**
 *   （`WsOpen`直接指定。接続そのものはsystem参照を要らない）。`systemRef`は
 *   **付加的**——ステータスバーのメッセージ表示等、system参照を要求するREST機能の
 *   ためだけに使う。無くても接続自体は成立する
 * - printer(スプール表示)/sql/ifs: `user`/`password`は**送らない**
 *   （REST層はsystem参照を要求し、直接指定を受け付けないため）。`systemRef`が
 *   無いと対象ペインは「設定を待っています」のプレースホルダーのまま止まる
 *
 * どちらも同期に失敗しても`connect`自体は送る——`systemRef`が無いまま
 * （emulatorなら画面は開くがメッセージ表示等は使えない、printer/sql/ifsなら
 * ペインが開かない）。失敗の詳細は`deps.log`へ残す。design.md「エラー処理/異常系」と
 * 同じ「他のフィールドは尊重し、致命的に倒さない」方針
 */
async function resolvePayload(
  file: Ts5250File,
  document: vscode.TextDocument,
  localPort: number,
  deps: Ts5250EditorProviderDeps
): Promise<ConnectPayload> {
  const payload = buildConnectPayload(file, deps.secretCrypto);
  const user = payload.user;
  const password = payload.password;
  if (file.app !== "emulator") {
    delete payload.user;
    delete payload.password;
  }
  const input: SystemSyncInput = { documentUri: document.uri.toString(), name: basename(document.fileName), host: payload.host };
  if (file.port !== undefined) input.port = file.port;
  if (file.tls !== undefined) input.tls = file.tls;
  if (file.ccsid !== undefined) input.ccsid = file.ccsid;
  if (user !== undefined) input.user = user;
  if (password !== undefined) input.password = password;
  try {
    payload.systemRef = await deps.syncSystem(localPort, input);
  } catch (e) {
    deps.log(`system同期に失敗しました（${file.app}）: ${e instanceof Error ? e.message : String(e)}`);
  }
  return payload;
}

/**
 * `Ts5250File` → `ConnectPayload`（`host`は必須なので空文字列で埋める。design.md
 * 「`.ts5250`ファイルスキーマ」）。
 *
 * **`passwordEnc`の復号に失敗しても呼び出し全体を失敗にしない**——`password`を省いた
 * ペイロードを返す。理由は2つ:
 * 1. `sendConnect`（ファイルを開いた直後）で失敗にすると、パスワード以外は正しい設定でも
 *    画面が一切開けなくなる（自動サインオンが効かないだけで、手動サインオンの余地は残したい）
 * 2. `handleSave`（設定保存後）で失敗にすると、**`WorkspaceEdit`は既に成功して
 *    ファイルへ書き込み済みなのに、`saveError`（保存に失敗した、という意味の型）を送ることになり
 *    利用者に嘘を伝える**——「保存は成功したが、既存の壊れたパスワードだけ読めない」と
 *    「保存そのものが失敗した」は別の事実であり、同じメッセージ型に押し込めない
 *    （taskcheck T9の指摘。以前は`{ok:false}`を返しており、`handleSave`側がこの2つを混同していた）
 */
function buildConnectPayload(file: Ts5250File, crypto: ExtensionSecretCrypto): ConnectPayload {
  const payload: ConnectPayload = { app: file.app, host: file.host ?? "" };
  if (file.port !== undefined) payload.port = file.port;
  if (file.tls !== undefined) payload.tls = file.tls;
  if (file.ccsid !== undefined) payload.ccsid = file.ccsid;
  if (file.katakanaVariant !== undefined) payload.katakanaVariant = file.katakanaVariant;
  if (file.terminal !== undefined) payload.terminal = file.terminal;
  if (file.deviceName !== undefined) payload.deviceName = file.deviceName;
  if (file.screenSize !== undefined) payload.screenSize = file.screenSize;
  if (file.enhanced !== undefined) payload.enhanced = file.enhanced;
  if (file.watermark !== undefined) payload.watermark = file.watermark;
  if (file.ifsPath !== undefined) payload.ifsPath = file.ifsPath;
  if (file.sqlInitial !== undefined) payload.sqlInitial = file.sqlInitial;
  if (file.signon?.user !== undefined) payload.user = file.signon.user;
  if (typeof file.signon?.passwordEnc === "string") {
    try {
      payload.password = crypto.decrypt(file.signon.passwordEnc);
    } catch {
      /* 改ざん・master key不一致等。passwordを省いたまま返す（上のJSDoc参照） */
    }
  }
  return payload;
}

/** 設定フォームの保存: パスワードを暗号化し、`.ts5250`へ`WorkspaceEdit`で書き戻す */
async function handleSave(
  webview: vscode.Webview,
  document: vscode.TextDocument,
  localPort: number,
  values: SettingsFormValues,
  deps: Ts5250EditorProviderDeps
): Promise<void> {
  const crypto = deps.secretCrypto;
  const parsed = parseTs5250File(document.getText());
  const base: Ts5250File = parsed.ok ? parsed.file : { app: "emulator" };
  const next: Ts5250File = { ...base, host: values.host };
  if (values.port !== undefined) next.port = values.port;
  else delete next.port;
  if (values.tls !== undefined) next.tls = values.tls;
  else delete next.tls;
  if (values.ccsid !== undefined) next.ccsid = values.ccsid;
  else delete next.ccsid;
  if (values.katakanaVariant !== undefined) next.katakanaVariant = values.katakanaVariant;
  else delete next.katakanaVariant;
  if (values.terminal !== undefined) next.terminal = values.terminal;
  else delete next.terminal;
  if (values.screenSize !== undefined) next.screenSize = values.screenSize;
  else delete next.screenSize;
  if (values.watermark !== undefined) next.watermark = values.watermark;
  else delete next.watermark;
  if (values.deviceName !== undefined) next.deviceName = values.deviceName;
  else delete next.deviceName;
  if (values.user !== undefined || values.password !== undefined) {
    next.signon = { ...base.signon };
    if (values.user !== undefined) next.signon.user = values.user;
    if (values.password !== undefined) next.signon.passwordEnc = crypto.encrypt(values.password);
  }

  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  edit.replace(document.uri, fullRange, stringifyTs5250File(next));
  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    post(webview, { type: "saveError", message: "保存に失敗しました。ファイルが他で変更された可能性があります。" });
    return;
  }

  post(webview, { type: "saved", payload: await resolvePayload(next, document, localPort, deps) });
}

function failureHtml(message: string): string {
  const esc = message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return `<!DOCTYPE html><html><body><p>サーバーを起動できませんでした: ${esc}</p><p>詳しくは出力パネルの「ts5250」を確認してください。</p></body></html>`;
}
