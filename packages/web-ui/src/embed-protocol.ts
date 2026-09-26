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

/**
 * `emulator`/`printer`は**セッション**（装置を掴む接続を持つ。接続／切断がある）。
 * `spool`/`sql`/`ifs`はREST（操作ごとに接続する。「開く」だけ）。
 * `printer`はプリンターセッション（本来のアプリの「プリンター」）で、既存スプールの一覧は`spool`
 * （本来のアプリの「スプール」）——D20でこの呼び名に揃えた（以前は`printer`がスプール表示を指していた）
 */
export const EMBED_APP_KINDS = ["emulator", "printer", "spool", "sql", "ifs"] as const;
/**
 * **種別の一覧はここ（`EMBED_APP_KINDS`）1か所だけ**。以前は型・`schema.ts`・`stores/embed.ts`・
 * `embed.ts`の4か所に書き写しており、D20で`spool`を足したとき`embed.ts`だけ漏れて、スプールの
 * 画面が「5250端末」と名乗る不具合になった（D21）。検証する側は全部これを参照する
 */
export type EmbedAppKind = (typeof EMBED_APP_KINDS)[number];

/**
 * **種別ごとのファイル拡張子**（`20260924-vscode-extension` D32）。VSCode拡張は拡張子で種別を決める——
 * 以前は1つの拡張子（`.ts5250`）の中身の`app`で種別を決めていたが、それだと空のファイルを作って画面だけで
 * 設定することができなかった（種別を画面で選べない。利用者の指摘）。`vscode-extension/package.json`の
 * `customEditors`/`languages`はこの表と同じでなければならない（`vscode-extension/test/package-json.test.ts`が突き合わせる）
 */
export const EMBED_APP_EXTENSIONS: Record<EmbedAppKind, string> = {
  emulator: ".ts5250emu",
  printer: ".ts5250prt",
  spool: ".ts5250spl",
  sql: ".ts5250sql",
  ifs: ".ts5250ifs"
};

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
