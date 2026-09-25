/**
 * `packages/web-ui/src/embed-protocol.ts` の型定義部分と**手で同期を保つ複製**。
 *
 * 拡張機能（Node/Electron環境）とWeb UI（ブラウザ環境）は別npmパッケージで、
 * どちらか一方から型をimportする経路が無い（ブラウザ専用の`@ts5250/web-ui`を
 * 拡張側の依存に加えるのは実行環境の向きとして逆）。ここは`EmbedAppKind`以降の
 * 型宣言をweb-ui側と一字一句同じに保つ——`test/protocol-sync.test.ts`が
 * 2ファイルを直接読み比べて固定する（`.aidev/works/20260924-vscode-extension/
 * architecture.md`「設計判断」）。
 *
 * `app` はURLクエリ（`embed.html?app=emulator`）で渡す（非秘匿・iframe初期ロード時に必要）。
 * `user`/`password` はURLに乗せず、`ready` ハンドシェイク後の `connect` メッセージでのみ渡す。
 */

export type EmbedAppKind = "emulator" | "printer" | "sql" | "ifs";

/** 拡張ホスト → WebView（shellを素通しして embed.html まで届く） */
export type HostToWebviewMessage =
  | { type: "connect"; payload: ConnectPayload }
  | { type: "saved"; payload: ConnectPayload }
  | { type: "saveError"; message: string }
  | { type: "fileInvalid"; message: string };

/** WebView（embed.html） → 拡張ホスト（shellを素通しして拡張ホストまで届く） */
export type WebviewToHostMessage =
  | { type: "ready" }
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
  deviceName?: string;
  user?: string;
  /** 平文。受け取った側（拡張ホスト）がすぐ暗号化し、保持しない */
  password?: string;
}
