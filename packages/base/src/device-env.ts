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

/**
 * **930/5026（日本語カタカナ）だけが持つ、キーボード配列の選択**（`20260922-katakana-variant-setting`）。
 *
 * ACS はこれを「ホスト・コード・ページ」の設定画面で**利用者ごとに選ばせる**（利用者提示の
 * スクリーンショットで確認）。「どちらが正しいか」を当 PJ が決め打ちできる軸ではない。
 *
 * - `"katakana"` ＝ ACS の「Katakana」（`KEY_JAPAN_KATAKANA`）。290 として扱われ CHARSET 332。
 *   実機の ACS のコアで確認（`scripts/acs-probe/ccsid290-invalid-chars.txt`）: 半角英小文字を
 *   大文字化し、`[ ] ^ ` { } ~ ¢` の 8 字をエラーにする（原典 `CodePage.isValidChar` が
 *   `icodepage == 290` のときだけこの 8 字を偽にする）
 * - `"katakana-ex"` ＝ ACS の「Katakana Extended」（`KEY_JAPAN_KATAKANA_EX`）。CHARSET 1172。
 *   小文字のまま・8 字とも入力できる
 *
 * 未指定（`undefined`）は当 PJ の**現状の折衷**（CHARSET 1172＝Extended 寄り・入力は大文字化する
 * ＝Katakana 寄り・8 字は拒否しない＝Extended 寄り）のまま変えない——既存の利用者の挙動を変えない
 * ための既定（`20260922-katakana-variant-setting` requirements AC4）。
 */
export type KatakanaVariant = "katakana" | "katakana-ex";

const DEVICE_ENV: ReadonlyMap<number, DeviceEnv> = new Map([
  [37, { kbdType: "USB", codePage: 37, charSet: 697 }],
  [273, { kbdType: "AGB", codePage: 273, charSet: 697 }],
  // 日本語 DBCS は SBCS 部を申告する（930/5026=カタカナ 290、939/5035/931/1399=英小文字 1027）
  // CHARSET 1172 は「Katakana Extended」の既定値（KatakanaVariant のコメント参照）。
  // "katakana" を選んだときだけ deviceEnvFor が 332 に差し替える
  [930, { kbdType: "JKB", codePage: 290, charSet: 1172 }],
  [5026, { kbdType: "JKB", codePage: 290, charSet: 1172 }],
  // 939 の KBDTYPE は ACS 実機の申告に合わせて JPB（従来 JEB）。930 は ACS の「Katakana Extended」
  // （`KEY_JAPAN_KATAKANA_EX`）と同じ。ACS の「Katakana」（`KEY_JAPAN_KATAKANA`）は 290 として扱われ CHARSET が 332 になる
  [939, { kbdType: "JPB", codePage: 1027, charSet: 1172 }],
  [5035, { kbdType: "JEB", codePage: 1027, charSet: 1172 }],
  [931, { kbdType: "JEB", codePage: 1027, charSet: 1172 }],
  // **1399 は ACS と同じく JPE・1027・32000**（`20260921-device-env-1399`。ACS `CodePage.getKbdType` の
  // `KEY_JAPAN_ENGLISH_EX_EURO` → JPE、`getHostCodePage_CharSet` の GCSGID 65535 を `NVT5250` が 32000 に置き換える。
  // ACS のコアに当ててワイヤでも確かめた）。~~JEB・1172~~
  [1399, { kbdType: "JPE", codePage: 1027, charSet: 32000 }]
]);

/** 930/5026 の「Katakana」だけが申告する CHARSET（ACS の `getHostCodePage_CharSet`。290 扱い）。 */
const KATAKANA_CHARSET = 332;

/**
 * CCSID に対応するデバイス属性（未知の CCSID は `undefined`＝申告しない）。
 *
 * `katakanaVariant` は 930/5026 のときだけ意味を持つ（`"katakana"` なら CHARSET を 332 に
 * 差し替える）。それ以外の CCSID・`undefined`・`"katakana-ex"` は無視して既定の表のまま返す。
 */
export function deviceEnvFor(ccsid: number, katakanaVariant?: KatakanaVariant): DeviceEnv | undefined {
  const dev = DEVICE_ENV.get(ccsid);
  if (dev && (ccsid === 930 || ccsid === 5026) && katakanaVariant === "katakana") {
    return { ...dev, charSet: KATAKANA_CHARSET };
  }
  return dev;
}
