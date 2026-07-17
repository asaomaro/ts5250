/**
 * 端末タイプ名の決定。
 *
 * SBCS 24x80 = IBM-3179-2、SBCS 27x132 = IBM-3477-FC（RFC 1205 の一覧どおり）。
 * DBCS 24x80 = IBM-5555-G02、DBCS 27x132 = IBM-5555-C01。
 *
 * DBCS 側は RFC 1205 に載っておらず、IBM のドキュメントも 5555 系を一律
 * 「24x80 または 27x132」と書くだけでサイズを型番に紐づけていない（tn5250 は DBCS 自体が
 * 未実装で先例にならない）。そのため PUB400 実機で総当たりして決めた:
 *
 *   IBM-5555-B01  モノクロ  24x80    …… 色が落ちる（青/桃/黄が出ない）
 *   IBM-5555-C01  カラー    27x132
 *   IBM-5555-G01  モノクロ  24x80    …… 同上
 *   IBM-5555-G02  カラー    24x80
 *   IBM-5555-A01 / D01 / E01 / F01   …… ホストが交渉を拒否（telnet の名前ではない）
 *
 * 当エミュレーターはカラー表示なので、カラーの 2 つ（24x80=G02 / 27x132=C01）を使う。
 * G02 は定義上「グラフィックス表示」だが、グラフィックス非対応は Query Reply（t[53]=0）で
 * 別途申告しており、実機でも表示は正常。
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
  if (dbcs) return screenSize === "27x132" ? "IBM-5555-C01" : "IBM-5555-G02";
  return screenSize === "27x132" ? "IBM-3477-FC" : "IBM-3179-2";
}

export function isDbcsCcsid(ccsid: number): boolean {
  return DBCS_CCSIDS.has(ccsid);
}

/**
 * プリンターセッションの端末タイプ名。
 *
 * SBCS = IBM-3812-1（tn5250 lp5250d が使う唯一のプリンター型番。PUB400 実機で I902＝
 * 「Session successfully started」を確認済み）。
 *
 * DBCS プリンターの型番は tn5250 にも RFC 1205 にも定義が無く（DBCS プリンターは未実装）、
 * 表示 DBCS の 5555 系と同じく実機総当たりで決める必要がある。DBCS 対応は後続作業のため、
 * 現状は SBCS 型番を返す（DBCS スプールの実 SCS 採取後に分岐を追加する）。
 */
export function printerTerminalTypeFor(ccsid: number): string {
  // DBCS の型番確定は後続。現状は IBM-3812-1（SBCS）で申告する。
  void ccsid;
  return "IBM-3812-1";
}
