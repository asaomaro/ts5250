import { EMBED_APP_EXTENSIONS, EMBED_APP_KINDS, type EmbedAppKind, type WatermarkValue } from "./protocol.js";

/**
 * 設定ファイル（`.ts5250emu`等。種別ごとに拡張子が違う——`EMBED_APP_EXTENSIONS`。D32）の中身の型。
 * **`app`はファイルには書かない**——拡張子から決まる。読み込み時に拡張子の種別を入れ、書き出し時に外す
 *
 * `ConnectPayload`（`protocol.ts`）とは別の型——ファイル上は`host`も`signon`も
 * **省略できる**（作成直後、利用者が待機画面の設定欄で埋める前の状態を許す）。
 * `ConnectPayload`は`host`が必須（空文字列で代用する）なので、変換は呼び出し側
 * （`ts5250EditorProvider.ts`）が行う。
 */
export interface Ts5250File {
  app: EmbedAppKind;
  host?: string;
  port?: number;
  tls?: boolean;
  ccsid?: number;
  katakanaVariant?: "katakana" | "katakana-ex";
  terminal?: "5250" | "3270";
  deviceName?: string;
  screenSize?: "24x80" | "27x132";
  enhanced?: boolean;
  watermark?: WatermarkValue;
  ifsPath?: string;
  sqlInitial?: string;
  signon?: {
    user?: string;
    /** `v1:iv:tag:ct`（`ExtensionSecretCrypto`で復号する） */
    passwordEnc?: string;
  };
}

const APP_KINDS: readonly EmbedAppKind[] = EMBED_APP_KINDS;

/** ファイル名の拡張子から種別を決める（大文字小文字は区別しない）。知らない拡張子なら`undefined` */
export function appKindFromFileName(fileName: string): EmbedAppKind | undefined {
  const lower = fileName.toLowerCase();
  return APP_KINDS.find((k) => lower.endsWith(EMBED_APP_EXTENSIONS[k]));
}

export type ParseResult = { ok: true; file: Ts5250File } | { ok: false; error: string };

/**
 * 設定ファイルのテキストを検証する。**厳密なスキーマ検証はしない**
 * （サーバー設定の`assertTypeConsistent`ほどの相互排他は課さない。単一ファイル・単一利用者なので実害が小さい）。
 * 見るのは「JSONのオブジェクトとして読めるか」だけ。種別（`app`）は呼び出し側が拡張子から渡す。
 * **空のファイル（空白だけを含む）は「何も設定していない」として受理する**——作ったばかりの空ファイルを開いて
 * 画面から設定できるようにするため（D32）。ファイルに`app`が書かれていても無視する（拡張子が正）
 */
export function parseTs5250File(text: string, app: EmbedAppKind): ParseResult {
  if (text.trim() === "") return { ok: true, file: { app } };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `JSONとして読めません: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "トップレベルはオブジェクトである必要があります" };
  }
  return { ok: true, file: { ...(raw as Omit<Ts5250File, "app">), app } };
}

/** 保存用に整形する（可読性のため2スペースインデント）。**`app`は書かない**（拡張子から決まる） */
export function stringifyTs5250File(file: Ts5250File): string {
  const rest: Partial<Ts5250File> = { ...file };
  delete rest.app;
  return `${JSON.stringify(rest, null, 2)}\n`;
}
