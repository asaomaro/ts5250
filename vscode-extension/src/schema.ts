import { EMBED_APP_KINDS, type EmbedAppKind, type WatermarkValue } from "./protocol.js";

/**
 * `.ts5250`ファイルの中身の型（design.md「`.ts5250`ファイルスキーマ」）。
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

export type ParseResult = { ok: true; file: Ts5250File } | { ok: false; error: string };

/**
 * `.ts5250`ファイルのテキストを検証する。**厳密なスキーマ検証はしない**
 * （サーバー設定の`assertTypeConsistent`ほどの相互排他は課さない。design.md
 * 「`.ts5250`ファイルスキーマ」——単一ファイル・単一利用者なので実害が小さい）。
 * 見るのは「JSONとして読めるか」「`app`が既知の種別か」の2点だけ。他のフィールドは
 * 型が違っていても、それぞれの使用箇所（`ts5250EditorProvider.ts`）が無視するか
 * 無害な既定値に倒す
 */
export function parseTs5250File(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `JSONとして読めません: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "トップレベルはオブジェクトである必要があります" };
  }
  const app = (raw as Record<string, unknown>).app;
  if (typeof app !== "string" || !APP_KINDS.includes(app as EmbedAppKind)) {
    return { ok: false, error: `app は ${APP_KINDS.join("/")} のいずれかである必要があります` };
  }
  return { ok: true, file: raw as Ts5250File };
}

/** 保存用に整形する（可読性のため2スペースインデント。既存のスタイルは保たない——シンプルさを優先） */
export function stringifyTs5250File(file: Ts5250File): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
