/**
 * 端末タイプ名の決定（RFC 4777 / spec）。
 * SBCS 24x80 = IBM-3179-2、SBCS 27x132 = IBM-3477-FC、
 * DBCS 24x80 = IBM-5555-C01、DBCS 27x132 = IBM-5555-B01。
 */
const DBCS_CCSIDS = new Set([930, 939, 1399, 931, 5035, 5026]);

/** RFC 2877 NEW-ENVIRON で申告するデバイス属性（キーボード種・EBCDIC コードページ・文字セット） */
export interface DeviceEnv {
  kbdType: string;
  codePage: number;
  charSet: number;
}

/**
 * CCSID → RFC 2877 の KBDTYPE / CODEPAGE / CHARSET。
 *
 * これを NEW-ENVIRON で申告すると、ホストは仮想デバイスをこのコードページで作り、
 * ジョブ CCSID との差を自動変換する。申告しないとホストはシステム既定でデバイスを作るため、
 * variant 文字（'@' 等）がクライアントの想定と食い違う。
 *
 * 実例: PUB400 は QCCSID=273（ドイツ語）。無申告だとデバイスも 273 になり、こちらが 37 で
 * 送った '@'（0x7C）をホストは '§' と読む（273 の '@' は 0xB5）。結果 '@' 入りパスワードが
 * 化けて signon 画面が CPF1120 で落ちる。申告すればホストが変換するのでどの CCSID でも通る
 * （37/273/930/939/1399 すべて PUB400 実機で確認済み）。
 */
const DEVICE_ENV: ReadonlyMap<number, DeviceEnv> = new Map([
  [37, { kbdType: "USB", codePage: 37, charSet: 697 }],
  [273, { kbdType: "AGB", codePage: 273, charSet: 697 }],
  // 日本語 DBCS は SBCS 部を申告する（930/5026=カタカナ 290、939/5035/931/1399=英小文字 1027）
  [930, { kbdType: "JKB", codePage: 290, charSet: 1172 }],
  [5026, { kbdType: "JKB", codePage: 290, charSet: 1172 }],
  [939, { kbdType: "JEB", codePage: 1027, charSet: 1172 }],
  [5035, { kbdType: "JEB", codePage: 1027, charSet: 1172 }],
  [931, { kbdType: "JEB", codePage: 1027, charSet: 1172 }],
  [1399, { kbdType: "JEB", codePage: 1027, charSet: 1172 }]
]);

/** CCSID に対応するデバイス属性（未知の CCSID は undefined＝申告しない）。 */
export function deviceEnvFor(ccsid: number): DeviceEnv | undefined {
  return DEVICE_ENV.get(ccsid);
}

export function terminalTypeFor(ccsid: number, screenSize: "24x80" | "27x132"): string {
  const dbcs = DBCS_CCSIDS.has(ccsid);
  if (dbcs) return screenSize === "27x132" ? "IBM-5555-B01" : "IBM-5555-C01";
  return screenSize === "27x132" ? "IBM-3477-FC" : "IBM-3179-2";
}

export function isDbcsCcsid(ccsid: number): boolean {
  return DBCS_CCSIDS.has(ccsid);
}
