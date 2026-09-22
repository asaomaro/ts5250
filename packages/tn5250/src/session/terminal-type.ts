import type { UserVar } from "../telnet/telnet.js";
import { ENV_ESC } from "../telnet/constants.js";

/**
 * 端末タイプ名の決定。
 *
 * SBCS 24x80 = IBM-3179-2、SBCS 27x132 = IBM-3477-FC（RFC 1205 の一覧どおり）。
 * **DBCS は画面サイズによらず IBM-5555-C01**（ACS と同じ。`20260921-dbcs-terminal-type`）。
 * ACS のコアに 930・1399 の 24x80 と 930 の 27x132 で当ててタップで採ったところ、どれも `IBM-5555-C01` を名乗った。
 * 画面サイズは Query Reply（`query-reply.ts` の t[50]。24x80 は 0x11・27x132 は 0x31）で申告する。
 *
 * ~~DBCS 24x80 = IBM-5555-G02~~——PUB400 の総当たりで「C01 は 27x132（STRSEU がワイドで来る）」と見て G02 を採っていたが、
 * それは当時の Query Reply が**常に 27x132 可（0x31）**と申告していたため。いまの申告なら C01 でも STRSEU は 24x80 で来る
 * （両方の実機で確かめた）。当時の総当たりの記録（B01・G01 はモノクロで色が落ちる、A01 ほかはホストが断る）は
 * `docs/PROTOCOL.md` §2.1 に残す。
 */
const DBCS_CCSIDS = new Set([930, 939, 1399, 931, 5035, 5026]);

export function terminalTypeFor(ccsid: number, screenSize: "24x80" | "27x132"): string {
  const dbcs = DBCS_CCSIDS.has(ccsid);
  if (dbcs) return "IBM-5555-C01";
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
