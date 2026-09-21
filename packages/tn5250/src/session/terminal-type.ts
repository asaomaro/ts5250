import type { UserVar } from "../telnet/telnet.js";
import { ENV_ESC } from "../telnet/constants.js";

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

export function terminalTypeFor(ccsid: number, screenSize: "24x80" | "27x132"): string {
  const dbcs = DBCS_CCSIDS.has(ccsid);
  if (dbcs) return screenSize === "27x132" ? "IBM-5555-C01" : "IBM-5555-G02";
  return screenSize === "27x132" ? "IBM-3477-FC" : "IBM-3179-2";
}

export function isDbcsCcsid(ccsid: number): boolean {
  return DBCS_CCSIDS.has(ccsid);
}

/**
 * プリンターセッションの端末タイプ名（ACS `DS5250P.initializeTelnet`。`20260921-printer-acs-declaration`）。
 *
 * **DBCS で HPT なしのときだけ `IBM-5553-B01`**、それ以外（SBCS・HPT あり）は `IBM-3812-1`。
 * ~~SBCS/DBCS とも IBM-3812-1。DBCS でも別型番（IBM-5553 系）は不要~~ は誤り——3812 の装置は IGC 属性の帳票を
 * 書き出せず CPA3303 で止まる。ACS の申告なら装置が 5553 として作られ（既存の 3812 の装置も作り変えられる）、
 * 日本語機で IGC の帳票が最後まで届いた。以前 5553-B01 が 8925 になったのは、一緒に送っていた
 * 当 PJ の変数の組のせいだった（PUB400 で当 PJ の組だけ 8925、ACS の組は I902。同 research F2・F3）。
 */
export function printerTerminalTypeFor(ccsid: number, transform = false): string {
  return isDbcsCcsid(ccsid) && !transform ? "IBM-5553-B01" : "IBM-3812-1";
}

/** プリンターの申告（端末タイプと、DEVNAME の後ろに送る USERVAR の並び） */
export interface PrinterDeclaration {
  terminalType: string;
  userVars: UserVar[];
}

/**
 * **プリンターの申告を ACS と同じ組にする**（`NVT5250` の `userVarPRTSB` / `userVarPRTDB` / `userVarPRTSBHPT` /
 * `userVarPRTDBHPT` と `insertVariable` の値。`20260921-printer-acs-declaration` research F1）。
 *
 * - 値は ACS の既定: メッセージ待ち行列 QSYSOPR / *LIBL、フォント 11、バッファ 768、IGC 機能 2424J0（日本語。
 *   当 PJ の DBCS の CCSID は日本語だけ）、用紙入れ・封筒 "00"（ESC＋0x00 で送る）、カスタマイズ・オブジェクト *NONE
 * - **KBDTYPE / CODEPAGE / CHARSET / IBMSENDCONFREC は送らない**（ACS はプリンターで送らない）
 * - 装置名（DEVNAME）と資格情報（USER ほか）は telnet 層が別に送る
 */
export function printerDeclaration(ccsid: number, transformTo?: string): PrinterDeclaration {
  const dbcs = isDbcsCcsid(ccsid);
  const msgq: UserVar[] = [{ name: "IBMMSGQNAME", value: "QSYSOPR" }, { name: "IBMMSGQLIB", value: "*LIBL" }];
  if (transformTo === undefined) {
    const userVars: UserVar[] = dbcs
      ? [...msgq, { name: "IBMFORMFEED" }, { name: "IBMIGCFEAT", value: "2424J0" }, { name: "IBMTRANSFORM", value: "0" }]
      : [
          ...msgq,
          { name: "IBMFONT", value: "11" },
          { name: "IBMFORMFEED" },
          { name: "IBMBUFFERSIZE", value: "768" },
          { name: "IBMTRANSFORM", value: "0" }
        ];
    return { terminalType: printerTerminalTypeFor(ccsid), userVars };
  }
  const tray = (name: string): UserVar => ({ name, raw: [ENV_ESC, 0x00] }); // 既定 "00"（`convertStringToByte`）
  const userVars: UserVar[] = [
    ...msgq,
    { name: "IBMFONT", value: "11" },
    { name: "IBMBUFFERSIZE", value: "768" },
    { name: "IBMTRANSFORM", value: "1" },
    // ACS は機種名を `_` の手前までで切る（設定の値に付く接尾辞を落とす）
    { name: "IBMMFRTYPMDL", value: transformTo.split("_")[0] },
    tray("IBMPPRSRC1"),
    tray("IBMPPRSRC2"),
    tray("IBMENVELOPE"),
    // IBMASCII899 は SBCS の組にだけある
    ...(dbcs ? [] : [{ name: "IBMASCII899", value: "0" }]),
    // IBMWSCSTLIB はカスタマイズ・オブジェクトを使うときだけ送る（`insertVariable` が飛ばす）
    { name: "IBMWSCSTNAME", value: "*NONE" }
  ];
  return { terminalType: printerTerminalTypeFor(ccsid, true), userVars };
}
