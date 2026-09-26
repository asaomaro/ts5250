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
 *
 * **`ready`は`connect`を自動発火しない**（`20260924-vscode-extension` D17。ファイルを開くと
 * 即座に接続してしまい、設定だけ変えたいときに困るとの利用者の要望）。実際に接続する
 * トリガーは利用者の明示的な「接続」ボタン——`resolveCustomTextEditor`参照。
 */

/**
 * `emulator`/`printer`は**セッション**（装置を掴む接続を持つ。接続／切断がある）。
 * `spool`/`sql`/`ifs`はREST（操作ごとに接続する。「開く」だけ）。
 * `printer`はプリンターセッション（本来のアプリの「プリンター」）で、既存スプールの一覧は`spool`
 * （本来のアプリの「スプール」）——D20でこの呼び名に揃えた（以前は`printer`がスプール表示を指していた）
 */
export type EmbedAppKind = "emulator" | "printer" | "spool" | "sql" | "ifs";

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
  /** 設定ファイル名（拡張子なし）。拡張ホストが付ける。画面の名前（本来のアプリのタブ名に当たる）に使う */
  title?: string;
  port?: number;
  tls?: boolean;
  ccsid?: number;
  katakanaVariant?: "katakana" | "katakana-ex";
  /** emulatorのみ */
  terminal?: "5250" | "3270";
  /** emulator/printer（セッション）のみ */
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
  /** emulator/printer（セッション）のみ。`WsOpen` へ直接渡す平文（design.md「設計方針3」） */
  user?: string;
  /** emulator/printer（セッション）のみ */
  password?: string;
  /** spool/sql/ifsで必須、セッションでは付加的。個人設定への登録が済んだ参照（例 `own:3f2a...`） */
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
  /** emulator/printer（セッション）のみ */
  deviceName?: string;
  /** emulatorのみ。terminal が 3270 のときは持たない（3270 はモデルで決まる。design.md参照） */
  screenSize?: "24x80" | "27x132";
  /** emulatorのみ。画面に重ねる透かし（表示だけの設定。ホストへは送らない） */
  watermark?: WatermarkValue;
  user?: string;
  /** 平文。受け取った側（拡張ホスト）がすぐ暗号化し、保持しない */
  password?: string;
}
