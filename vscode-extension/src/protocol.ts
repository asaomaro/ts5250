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

/** 拡張版の接続前設定。表示側・保存側で同じ項目集合を使い、転記漏れを防ぐ。 */
export interface EmbedConnectionOptions {
  enhanced?: boolean;
  allowPcCommand?: boolean;
  /** enabled は allowPcCommand が唯一の入口。詳細設定だけをここに持つ */
  pcCommand?: { allow?: string[]; timeoutMs?: number };
  printer?: { autoPdfDir?: string; autoPrint?: string };
  associatedPrinter?: string;
  deviceNameRetry?: boolean;
  keepAlive?: boolean;
  keepAliveOptions?: { initialDelayMs?: number | undefined; intervalMs?: number | undefined; count?: number | undefined };
  connectionHold?: number | "never";
  ifsPath?: string;
  /** 開いたときに入力する SQL。自動実行はしない */
  sqlInitial?: string;
}

const EMBED_CONNECTION_FIELDS: Record<keyof EmbedConnectionOptions, true> = {
  enhanced: true, allowPcCommand: true, pcCommand: true, printer: true, associatedPrinter: true,
  deviceNameRetry: true, keepAlive: true, keepAliveOptions: true, connectionHold: true, ifsPath: true, sqlInitial: true
};
export const EMBED_CONNECTION_KEYS = Object.keys(EMBED_CONNECTION_FIELDS) as (keyof EmbedConnectionOptions)[];

/** ファイル・postMessage・フォームで同じ検証を使う。未指定は既存の既定値を保つ。 */
export function embedConnectionError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "設定の形式が不正です";
  const v = value as Record<string, unknown>;
  for (const key of ["enhanced", "allowPcCommand", "deviceNameRetry", "keepAlive"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "boolean") return `${key} は true または false で指定してください`;
  }
  for (const key of ["associatedPrinter", "ifsPath", "sqlInitial"] as const) {
    if (v[key] !== undefined && typeof v[key] !== "string") return `${key} は文字列で指定してください`;
  }
  if (typeof v.ifsPath === "string" && v.ifsPath !== "" && !v.ifsPath.startsWith("/")) return "IFS の初期フォルダーは / から始まるパスで指定してください";
  if (v.connectionHold !== undefined && v.connectionHold !== "never" && (typeof v.connectionHold !== "number" || !Number.isInteger(v.connectionHold) || v.connectionHold < 0 || v.connectionHold > 1440)) return "接続保持時間は 0〜1440 の整数（分）または無期限で指定してください";
  if (v.keepAliveOptions !== undefined) {
    if (!v.keepAliveOptions || typeof v.keepAliveOptions !== "object" || Array.isArray(v.keepAliveOptions)) return "TCP キープアライブの詳細設定はオブジェクトで指定してください";
    const options = v.keepAliveOptions as Record<string, unknown>;
    if (Object.keys(options).some((k) => !["initialDelayMs", "intervalMs", "count"].includes(k))) return "TCP キープアライブに未対応の項目があります";
    for (const key of ["initialDelayMs", "intervalMs", "count"] as const) {
      const n = options[key];
      if (n === undefined) continue;
      if (typeof n !== "number" || !Number.isInteger(n) || (key === "count" ? n < 1 || n > 127 : n < 1000 || n > 32767000 || n % 1000 !== 0)) return "TCP キープアライブの時間は 1〜32767 の整数（秒）、回数は 1〜127 で指定してください";
    }
  }
  const pc = v.pcCommand;
  if (pc !== undefined) {
    if (!pc || typeof pc !== "object" || Array.isArray(pc)) return "PC コマンドの詳細設定はオブジェクトで指定してください";
    const p = pc as Record<string, unknown>;
    if (Object.keys(p).some((k) => k !== "allow" && k !== "timeoutMs")) return "PC コマンドの詳細設定に未対応の項目があります";
    if (p.timeoutMs !== undefined && (typeof p.timeoutMs !== "number" || !Number.isInteger(p.timeoutMs) || p.timeoutMs <= 0 || p.timeoutMs > 3_600_000)) return "PC コマンドの待ち時間上限は 0 秒より大きく 3600 秒以下で指定してください";
    if (p.allow !== undefined) {
      if (!Array.isArray(p.allow) || p.allow.length === 0 || p.allow.some((x) => typeof x !== "string" || x.length === 0)) return "許可パターンは空でない文字列の配列で指定してください";
      for (const pattern of p.allow as string[]) {
        if (pattern.startsWith("prog:")) {
          if (pattern.length === 5) return "prog: の後にプログラム名を指定してください";
        } else {
          try { new RegExp(`^(?:${pattern})$`); } catch { return "許可パターンの正規表現が不正です"; }
        }
      }
    }
  }
  if (v.printer !== undefined) {
    if (!v.printer || typeof v.printer !== "object" || Array.isArray(v.printer)) return "プリンターの出力設定はオブジェクトで指定してください";
    const printer = v.printer as Record<string, unknown>;
    if (Object.keys(printer).some((k) => k !== "autoPdfDir" && k !== "autoPrint")) return "プリンターの出力設定に未対応の項目があります";
    for (const key of ["autoPdfDir", "autoPrint"] as const) {
      if (printer[key] !== undefined && typeof printer[key] !== "string") return `${key} は文字列で指定してください`;
    }
  }
  return undefined;
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

export interface ConnectPayload extends EmbedConnectionOptions {
  app: EmbedAppKind;
  host: string;
  /** 設定ファイル名（拡張子なし）。拡張ホストが付ける。画面の名前（本来のアプリのタブ名に当たる）に使う */
  title?: string;
  port?: number;
  tls?: boolean;
  ccsid?: number;
  katakanaVariant?: "katakana" | "katakana-ex";
  /** spoolのみ。スプール（SCS）の復号CCSID。5250画面用の`ccsid`とは別。未指定ならサーバーの既定 */
  spoolCcsid?: number;
  /** emulatorのみ */
  terminal?: "5250" | "3270";
  /** emulator/printer（セッション）のみ */
  deviceName?: string;
  /** emulatorのみ */
  screenSize?: "24x80" | "27x132";
  /** emulatorのみ。画面に重ねる透かし（表示だけの設定。ホストへは送らない） */
  watermark?: WatermarkValue;
  /** emulator/printer（セッション）のみ。`WsOpen` へ直接渡す平文（design.md「設計方針3」） */
  user?: string;
  /** emulator/printer（セッション）のみ */
  password?: string;
  /** spool/sql/ifsで必須、セッションでは付加的。個人設定への登録が済んだ参照（例 `own:3f2a...`） */
  systemRef?: string;
  /** 拡張ホストが登録したサーバー設定のセッション参照。信頼設定を WS へ直接渡さない */
  sessionRef?: string;
}

export interface SettingsFormValues extends EmbedConnectionOptions {
  host: string;
  port?: number;
  tls?: boolean;
  ccsid?: number;
  katakanaVariant?: "katakana" | "katakana-ex";
  /** spoolのみ。スプール（SCS）の復号CCSID。5250画面用の`ccsid`とは別。未指定ならサーバーの既定 */
  spoolCcsid?: number;
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
