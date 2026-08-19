/**
 * CCSID → RFC 2877 の KBDTYPE / CODEPAGE / CHARSET。
 *
 * これを NEW-ENVIRON で申告すると、ホストは仮想デバイスをこのコードページで作り、
 * ジョブ CCSID との差を自動変換する。**申告しないとホストはシステム既定でデバイスを作るため、
 * variant 文字（`'@'` 等）がクライアントの想定と食い違う。**
 *
 * 実例（5250 側で実機確認済みの記録。3270 でも同じ経路を通る）:
 * PUB400 は QCCSID=273（ドイツ語）。無申告だとデバイスも 273 になり、こちらが 37 で
 * 送った `'@'`（0x7C）をホストは `'§'` と読む（273 の `'@'` は 0xB5）。
 * 結果 `'@'` 入りパスワードが化けて signon が CPF1120 で落ちる。
 * **3270 で実際に踏んだ**——同じ資格情報が 5250 では通るのに 3270 では落ちた。
 *
 * **`@ts5250/tn5250` の同名テーブルの複製**（decisions D2 / D7 と同じ判断）。
 * 値は同一だが、括るには tn5250 側を動かす必要がある。
 */
export interface DeviceEnv {
  kbdType: string;
  codePage: number;
  charSet: number;
}

const DEVICE_ENV: ReadonlyMap<number, DeviceEnv> = new Map([
  [37, { kbdType: "USB", codePage: 37, charSet: 697 }],
  [273, { kbdType: "AGB", codePage: 273, charSet: 697 }],
  // 日本語 DBCS は SBCS 部を申告する（930/5026=カタカナ 290、939/5035/931/1399=英小文字 1027）
  [930, { kbdType: "JKB", codePage: 290, charSet: 1172 }],
  [5026, { kbdType: "JKB", codePage: 290, charSet: 1172 }],
  [939, { kbdType: "JPB", codePage: 1027, charSet: 1172 }],
  [5035, { kbdType: "JEB", codePage: 1027, charSet: 1172 }],
  [931, { kbdType: "JEB", codePage: 1027, charSet: 1172 }],
  [1399, { kbdType: "JEB", codePage: 1027, charSet: 1172 }]
]);

/** CCSID に対応するデバイス属性（未知の CCSID は undefined＝申告しない） */
export function deviceEnvFor(ccsid: number): DeviceEnv | undefined {
  return DEVICE_ENV.get(ccsid);
}
