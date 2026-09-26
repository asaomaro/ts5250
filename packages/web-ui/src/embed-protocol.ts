/**
 * `embed.html`（単一アプリ専用の最小WebView）と、それをiframe表示するVSCode拡張機能
 * （`vscode-extension/`）の間で交わす `postMessage` の型。
 *
 * `vscode-extension/src/protocol.ts` に同じ形の複製を持つ（拡張機能は別npmパッケージで
 * 実行環境もNode/Electronであり、このパッケージから型をimportできない——ブラウザ専用の
 * `@ts5250/web-ui` を拡張側の依存に加えるのは逆方向）。**両者は手で同期を保つ**。
 * `vscode-extension`側に一致テストを置く（`.aidev/works/20260924-vscode-extension/architecture.md`
 * 「設計判断」）。
 *
 * `app` はURLクエリ（`embed.html?app=emulator`）で渡す（非秘匿・iframe初期ロード時に必要）。
 * `user`/`password` はURLに乗せず、`ready` ハンドシェイク後の `connect` メッセージでのみ渡す。
 *
 * **`ready`は`connect`を自動発火しない**（`20260924-vscode-extension` D17。利用者の要望
 * 「設定だけを変えたい場合にも接続されてしまう」への対応）。`ready`が受け取るのは
 * `loaded`（ファイルの現在値。表示・設定フォームの初期値用。**接続はしない**）だけで、
 * 実際に接続する（`connect`）のは利用者が明示的に「接続」ボタンを押し、WebViewが
 * `{ type: "connect" }`（payload無し）を送り返したときだけ。
 */

export type EmbedAppKind = "emulator" | "printer" | "sql" | "ifs";

/**
 * ウォーターマーク（画面に重ねる透かし）。`@ts5250/server`の`watermarkSchema`と同じ形だが、
 * **ここでは意図的にインライン定義する**（`@ts5250/server`からimportしない）——
 * `vscode-extension/src/protocol.ts`はこのファイルと手で同期を保つ複製で、
 * 拡張機能側から`@ts5250/server`をimportする経路が無いため（冒頭コメント参照）。
 */
export interface WatermarkValue {
  text: string;
  enabled?: boolean;
  opacity?: number;
  size?: number;
  layout?: "tile" | "center";
  angle?: number;
  color?: string;
}

/** 拡張ホスト → WebView（shellを素通しして embed.html まで届く） */
export type HostToWebviewMessage =
  /** ファイルを開いた直後・保存直後。**接続はしない**——表示・設定フォームの初期値用 */
  | { type: "loaded"; payload: ConnectPayload }
  /** 「接続」ボタン押下に応えて実際に接続する */
  | { type: "connect"; payload: ConnectPayload }
  | { type: "saved"; payload: ConnectPayload }
  | { type: "saveError"; message: string }
  | { type: "fileInvalid"; message: string };

/** WebView（embed.html） → 拡張ホスト（shellを素通しして拡張ホストまで届く） */
export type WebviewToHostMessage =
  | { type: "ready" }
  /** 「接続」ボタン押下。payloadは無い——拡張ホストは既にファイルを持っている */
  | { type: "connect" }
  | { type: "save"; payload: SettingsFormValues }
  | { type: "openExternal"; url: string };

export interface ConnectPayload {
  app: EmbedAppKind;
  host: string;
  port?: number;
  tls?: boolean;
  ccsid?: number;
  katakanaVariant?: "katakana" | "katakana-ex";
  /** emulatorのみ */
  terminal?: "5250" | "3270";
  /** emulatorのみ */
  deviceName?: string;
  /** emulatorのみ */
  screenSize?: "24x80" | "27x132";
  /** emulatorのみ */
  enhanced?: boolean;
  /** emulatorのみ。画面に重ねる透かし（表示だけの設定。ホストへは送らない） */
  watermark?: WatermarkValue;
  /** ifsのみ。初期表示ディレクトリ */
  ifsPath?: string;
  /** sqlのみ。初期クエリ */
  sqlInitial?: string;
  /** emulatorのみ。`WsOpen` へ直接渡す平文（design.md「設計方針3」） */
  user?: string;
  /** emulatorのみ */
  password?: string;
  /** printer(スプール表示)/sql/ifsのみ。個人設定への登録が済んだ参照（例 `own:3f2a...`） */
  systemRef?: string;
}

export interface SettingsFormValues {
  host: string;
  port?: number;
  tls?: boolean;
  ccsid?: number;
  katakanaVariant?: "katakana" | "katakana-ex";
  /** emulatorのみ */
  terminal?: "5250" | "3270";
  /** emulatorのみ */
  deviceName?: string;
  /** emulatorのみ。terminal が 3270 のときは持たない（3270 はモデルで決まる。design.md参照） */
  screenSize?: "24x80" | "27x132";
  /** emulatorのみ。画面に重ねる透かし（表示だけの設定。ホストへは送らない） */
  watermark?: WatermarkValue;
  user?: string;
  /** 平文。受け取った側（拡張ホスト）がすぐ暗号化し、保持しない */
  password?: string;
}
