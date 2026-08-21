/**
 * RFC 2877 の **KBDTYPE / CODEPAGE / CHARSET**——IBM i に「この端末はこのコードページだ」と
 * 名乗るための値。
 *
 * NEW-ENVIRON でこれを申告すると、ホストは仮想デバイスをこのコードページで作り、
 * ジョブ CCSID との差を**ホスト側で**変換する。**申告しないとホストはシステム既定で
 * デバイスを作るため、variant 文字（`'@'` 等）がクライアントの想定と食い違う。**
 *
 * 実例（実機で 3 回踏んでいる）: PUB400 は `QCCSID=273`（ドイツ語）。無申告だとデバイスも
 * 273 になり、こちらが 37 で送った `'@'`（0x7C）をホストは `'§'` と読む（273 の `'@'` は 0xB5）。
 * 結果 `'@'` 入りパスワードが化けて signon が **CPF1120** で落ちる。
 *
 * - **5250**: 申告すれば 37/273/930/939/1399 すべて PUB400 実機で通ることを確認済み
 * - **3270**: 同じ資格情報が 5250 では通るのに 3270 では落ちて、ここに行き着いた
 * - **VT**: 同上（`20260821-vt-terminal-core` の research 1.3）
 *
 * ## なぜ `@ts5250/base` に居るか
 *
 * **`tn5250` / `tn3270` / `vt` の 3 つが要るが、どれの持ち物でもない**——AGENTS.md の
 * 「`base` に置く基準 2」そのもの。以前は tn5250 と tn3270 に**同じ表が 2 つ**あり、
 * tn3270 側のコメントが「複製」と明記していた。VT で 3 つ目を作る前にここへ括った。
 */
export interface DeviceEnv {
  /** キーボード種別（RFC 2877 `KBDTYPE`）。**これが無いと反応しないホストがある** */
  kbdType: string;
  /** EBCDIC のコードページ（`CODEPAGE`） */
  codePage: number;
  /** 文字セット（`CHARSET`） */
  charSet: number;
}

const DEVICE_ENV: ReadonlyMap<number, DeviceEnv> = new Map([
  [37, { kbdType: "USB", codePage: 37, charSet: 697 }],
  [273, { kbdType: "AGB", codePage: 273, charSet: 697 }],
  // 日本語 DBCS は SBCS 部を申告する（930/5026=カタカナ 290、939/5035/931/1399=英小文字 1027）
  [930, { kbdType: "JKB", codePage: 290, charSet: 1172 }],
  [5026, { kbdType: "JKB", codePage: 290, charSet: 1172 }],
  // 939 の KBDTYPE は ACS 実機の申告に合わせて JPB（従来 JEB）
  [939, { kbdType: "JPB", codePage: 1027, charSet: 1172 }],
  [5035, { kbdType: "JEB", codePage: 1027, charSet: 1172 }],
  [931, { kbdType: "JEB", codePage: 1027, charSet: 1172 }],
  [1399, { kbdType: "JEB", codePage: 1027, charSet: 1172 }]
]);

/** CCSID に対応するデバイス属性（未知の CCSID は `undefined`＝申告しない）。 */
export function deviceEnvFor(ccsid: number): DeviceEnv | undefined {
  return DEVICE_ENV.get(ccsid);
}
