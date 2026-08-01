/**
 * PC Organizer（`STRPCO` / `STRPCCMD`）の標識検出。
 *
 * ホストは 5250 の**画面データ**として、非表示属性（0x27）の下に固定の標識を書き、
 * その直後に PAUSE 指定 1 バイトとコマンド本文を並べて READ MDT FIELDS で待つ。
 * 実行できるクライアントはコマンドを走らせて実行キーを返し、利用者にはこの画面を見せない。
 * 未対応クライアントには「PCO.EXE が活動状態でない」という案内画面として見える
 * （＝この画面はフォールバック表示を兼ねている）。
 *
 * バイト列は**実機（IBM i 7.x）で実測**した（`.aidev/works/20260728-strpco-strpccmd/research.md`）。
 * 参照実装 tn5250j `tnvt.java`（`case -128:`）・xtn5250 `XI5250Emulator.java`（`STRPCCMD` 定数）とも一致する。
 */

/** STRPCCMD の標識（属性 0x27 込みで 11 バイト）。"PCO " が読める */
export const PCO_START: readonly number[] = [
  0x27, 0x80, 0xfc, 0xd7, 0xc3, 0xd6, 0x40, 0x83, 0x80, 0xa1, 0x80
];

/**
 * PC Organizer 終了の標識。**未検証**——実機に `ENDPCO` コマンドが無く誘発できなかった
 * （research D6）。xtn5250 の `ENDSTRPCCMD` 定数から採り、**一致しても実行はしない**
 * （実行キーだけ返す）。誤って本文をコマンドとして解釈しないための保守的な扱い。
 */
export const PCO_END: readonly number[] = [
  0x27, 0x00, 0xfc, 0xd7, 0xc3, 0xd6, 0x40, 0x83, 0x80, 0x82, 0x00
];

/** 標識に続く PAUSE 指定: `'a'`(0x81) = 待たない。それ以外（実測は 0x80）= 待つ */
const PAUSE_NO_WAIT = 0x81;

/** ホストから届いた PC コマンド */
export interface PcCommandRequest {
  command: string;
  /** `PAUSE(*YES)` 相当。コマンドの終了を待ってからホストへ実行キーを返す */
  wait: boolean;
}

export type PcoMarkerKind = "start" | "end";

function startsWith(data: Uint8Array, marker: readonly number[]): boolean {
  for (let i = 0; i < marker.length; i++) {
    if (data[i] !== marker[i]) return false;
  }
  return true;
}

/**
 * 現在位置が PC Organizer の標識かを判定する（**1 バイトも消費しない**）。
 *
 * 消費しないのは、標識のバイト列を今までどおり画面バッファへ書くため。
 * 非表示属性の下なので見えないが、消してしまうと READ SCREEN 応答の画面イメージが
 * 他クライアントと変わる（AGENTS.md「既存クライアントと同じ挙動」）。
 */
export function detectPcoMarker(bytes: Uint8Array | undefined): PcoMarkerKind | undefined {
  if (!bytes || bytes.length < PCO_START.length) return undefined;
  if (startsWith(bytes, PCO_START)) return "start";
  if (startsWith(bytes, PCO_END)) return "end";
  return undefined;
}

/**
 * 標識の直後から PAUSE 指定とコマンド本文を読む（**消費しない**。`data` は標識の先頭を指す）。
 *
 * 本文の終端は**空白詰めではなくオーダー**（実測は RA）。したがって
 * 「表示可能データ（0x40 以上）が続く限り」で切り、末尾の空白だけを落とす。
 * 27x132 の 1 行（132 桁）を越えても**ホストは折返しに SBA を挟まない**ので、
 * データストリームを素直に読み進めればよい（research D4）。
 */
export function readPcCommand(
  data: Uint8Array,
  decodeByte: (b: number) => number
): PcCommandRequest {
  const pause = data[PCO_START.length];
  const wait = pause !== PAUSE_NO_WAIT;
  let command = "";
  for (let i = PCO_START.length + 1; i < data.length; i++) {
    const b = data[i]!;
    if (b < 0x40) break; // オーダー（RA 等）＝本文の終わり
    command += String.fromCharCode(decodeByte(b));
  }
  return { command: command.replace(/\s+$/, ""), wait };
}
