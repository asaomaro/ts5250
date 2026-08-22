/**
 * PC Organizer（`STRPCO` / `STRPCCMD`）の標識検出。
 *
 * ホストは 5250 の**画面データ**として、非表示属性（0x27）の下に固定の標識を書き、
 * その直後に PAUSE 指定 1 バイトとコマンド本文を並べて READ MDT FIELDS で待つ。
 * 実行できるクライアントはコマンドを走らせて実行キーを返し、利用者にはこの画面を見せない。
 * 未対応クライアントには「PCO.EXE が活動状態でない」という案内画面として見える
 * （＝この画面はフォールバック表示を兼ねている）。
 *
 * バイト列は**実機 SR-OSAKA（IBM i 7.x）で実測**した（`.aidev/works/20260728-strpco-strpccmd/research.md`）。
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

/** シフトアウト／シフトイン（DBCS 区間の囲み） */
const SO = 0x0e;
const SI = 0x0f;

/**
 * V7R2 以降の `PCCMD` パラメータ上限（**文字数**。research D4）。
 *
 * SR-OSAKA（7.3）では 200 文字を受け付けず対話ジョブが止まったので、
 * **この値まで実機で出せたわけではない**。「ここまでは来うる」の上限として扱う。
 */
export const PCCMD_MAX_CHARS = 1023;

/**
 * 標識を見つけたときに先読みするバイト数。
 *
 * ⚠ **上限いっぱいの本文が入る大きさが要る。** 以前は 512 で、本文が約 500 バイトを
 * 越えると**黙って切れていた**（切れたことすら分からない）。DBCS は 1 文字 2 バイトなので
 * 最悪 `PCCMD_MAX_CHARS * 2`、加えて SO/SI の囲みぶんの余裕を見る。
 */
export const PCO_SCAN_BYTES = PCO_START.length + 1 + PCCMD_MAX_CHARS * 2 + 64;

/** ホストから届いた PC コマンド */
export interface PcCommandRequest {
  command: string;
  /** `PAUSE(*YES)` 相当。コマンドの終了を待ってからホストへ実行キーを返す */
  wait: boolean;
  /**
   * **本文の終端に届かないまま先読み窓を使い切った。**
   *
   * 切れた本文をそのまま実行すると、**利用者の意図と違うコマンドが走る**
   * （`del a.txt b.txt` が `del a.txt` になる類）。呼び出し側は実行せずに捨てること。
   */
  truncated: boolean;
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
 *
 * ## DBCS を含む本文
 *
 * ⚠ **1 バイトずつ復号してはいけない。** SO(0x0e) / SI(0x0f) は `0x40` 未満なので、
 * 素朴に「0x40 未満で終わり」とすると**最初の全角文字で本文が切れる**
 * （日本語のパスを含むコマンドが頭だけになる）。
 *
 * SO/SI は**本文の一部として集め、復号はコーデックに任せる**——`decode` が
 * SO/SI のステートマシンを持っており、DBCS 対を 1 文字に畳んでくれる。
 * ここで持つのは「どこまでが本文か」の判断だけにする。
 */
export function readPcCommand(
  data: Uint8Array,
  decode: (bytes: Uint8Array) => string
): PcCommandRequest {
  const pause = data[PCO_START.length];
  const wait = pause !== PAUSE_NO_WAIT;
  const raw: number[] = [];
  let dbcs = false;
  let terminated = false;
  let i = PCO_START.length + 1;
  for (; i < data.length; i++) {
    const b = data[i]!;
    if (b === SO) {
      dbcs = true;
      raw.push(b);
      continue;
    }
    if (b === SI) {
      dbcs = false;
      raw.push(b);
      continue;
    }
    // オーダー（RA 等）＝本文の終わり。DBCS 区間の中でも同じ——
    // 対の途中に 0x40 未満が出るのは並びが壊れているときなので、そこで切る
    if (b < 0x40) {
      terminated = true;
      break;
    }
    raw.push(b);
  }
  // SI で閉じないまま終わったら閉じる（`decode` が最後の 1 バイトを対の頭と誤らないように）
  if (dbcs) raw.push(SI);
  return {
    command: decode(Uint8Array.from(raw)).replace(/\s+$/u, ""),
    wait,
    // 窓を使い切って終端に届いていない＝切れている可能性がある
    truncated: !terminated && i >= data.length
  };
}
