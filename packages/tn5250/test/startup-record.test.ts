import { describe, it, expect } from "vitest";
import {
  parseStartupResponse,
  startupCodeMeaning,
  isKnownStartupCode,
  knownStartupCodes,
  STARTUP_SUCCESS_CODES
} from "../src/telnet/startup-record.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";

/**
 * 起動応答レコード（RFC 4777 §10）。
 *
 * **バイト列は実機（PUB400）で捕えたもの**——装置名を指定せず接続したときの 1 レコード目。
 * ここから「実際に割り当てられた装置名」が分かるので、画面に触れずにジョブ名を知れる。
 */

/** 実機の 1 レコード目（73 バイト）。I902 / PUB400 / QPADEV001P */
const REAL_RECORD = Uint8Array.from([
  0x00, 0x49, 0x12, 0xa0, 0x90, 0x00, 0x05, 0x60, 0x06, 0x00, 0x20, 0xc0, 0x00, 0x3d, 0x00, 0x00,
  0xc9, 0xf9, 0xf0, 0xf2, // "I902"
  0xd7, 0xe4, 0xc2, 0xf4, 0xf0, 0xf0, 0x40, 0x40, // "PUB400  "
  0xd8, 0xd7, 0xc1, 0xc4, 0xc5, 0xe5, 0xf0, 0xf0, 0xf1, 0xd7, // "QPADEV001P"
  ...new Array<number>(73 - 38).fill(0)
]);

describe("起動応答レコード", () => {
  it("実機のレコードから 応答コード・システム名・装置名 を取る", () => {
    expect(parseStartupResponse(REAL_RECORD)).toEqual({
      code: "I902",
      system: "PUB400",
      device: "QPADEV001P"
    });
  });

  /**
   * **セッションの CCSID によらず CCSID 37 で読む**（ACS `processStartUpConfirmation` の `new CodePage(37, 2)`。`20260921-startup-record-cp037`）。
   * 930 / 5026 の SBCS（290）では 0x5B が `¥` なので、セッションの codec で読むと `$` を含む装置名が化けていた
   */
  it("**`$` を含む装置名は `$` のまま**（930 の codec なら `¥` に化ける）", () => {
    const rec = Uint8Array.from(REAL_RECORD);
    rec.set([0xc4, 0xe2, 0xd7, 0x5b, 0xf0, 0xf1, 0x40, 0x40, 0x40, 0x40], 28); // "DSP$01"
    expect(codecForCcsid(930).decode(rec.subarray(28, 34)), "前提: 930 では化ける").toBe("DSP¥01");
    expect(parseStartupResponse(rec)?.device).toBe("DSP$01");
  });

  /**
   * **通常のデータストリームを食べないこと。**
   * 誤って起動応答と判定すると、そのレコードが画面へ流れず画面が出なくなる。
   */
  it("応答コードの形をしていないレコードは起動応答ではない", () => {
    // 実機の WTD レコード（0x12a0 ヘッダ・opcode 3）を模したもの
    const data = Uint8Array.from([
      0x00, 0x11, 0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x03, 0x04, 0xf3, 0x00, 0x05, 0xd9,
      0x70, 0x00
    ]);
    expect(parseStartupResponse(data)).toBeUndefined();
  });

  it("短すぎるレコードは undefined", () => {
    expect(parseStartupResponse(Uint8Array.from([0x00, 0x04, 0x12, 0xa0]))).toBeUndefined();
  });

  /** プリンターは応答コードだけで可否を判断する。短い応答でも壊れないこと */
  it("応答コードだけの短い応答も読める（システム名・装置名は空）", () => {
    const short = Uint8Array.from([
      0x00, 0x13, 0x12, 0xa0, 0x90, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0xf8, 0xf9, 0xf0, 0xf2 // "8902"
    ]);
    expect(parseStartupResponse(short)).toEqual({ code: "8902", system: "", device: "" });
  });

  it("成功コードと意味", () => {
    expect(STARTUP_SUCCESS_CODES.has("I902")).toBe(true);
    expect(STARTUP_SUCCESS_CODES.has("8902")).toBe(false);
    expect(startupCodeMeaning("8902")).toBe("Device not available.");
    expect(startupCodeMeaning("9999")).toBe("unknown startup response");
  });
});

/**
 * **ACS が個別に扱う起動応答**（`20260921-startup-codes-unknown`）。
 *
 * `acshod2.jar` の `DS5250.processStartUpConfirmation` を `javap -c -constants` で読むと、
 * この 4 つが lookupswitch の**個別の分岐**として実在し、それぞれ別の通信状態
 * （`ECLSession.SetCommStatus`）へ落ちる——2703→12 / 2777→13 / 8936→33 / 8937→34。
 *
 * **認識は `CODE_MEANING` のキーが唯一の出所**なので、表に無いと起動応答と見なされず
 * 5250 データとして解析される。8936 / 8937 は自動サインオンの失敗・拒否で、
 * 当 PJ は自動サインオンを持つため**到達しうる**。
 */
describe("ACS が個別に扱う 4 コード", () => {
  const codes = ["2703", "2777", "8936", "8937"] as const;

  it("既知として認識する（未知だと 5250 データに流れ込む）", () => {
    for (const c of codes) expect(isKnownStartupCode(c), c).toBe(true);
  });

  it("成功ではない（4 つとも失敗）", () => {
    for (const c of codes) expect(STARTUP_SUCCESS_CODES.has(c), c).toBe(false);
  });

  it("意味が引ける（未知の既定文言に落ちない）", () => {
    for (const c of codes) expect(startupCodeMeaning(c), c).not.toBe("unknown startup response");
  });

  // ~~意味が未確認のものは、そう分かる文言にする~~ → ACS の文言表（`hod_en` の `KEY_5250_CONNECTION_ERR_*`）で意味が分かった
  // （`20260921-startup-codes-japanese`）。8936 も同じ表の意味に直した（以前は「自動サインオンの失敗」と書いていた）
  it("**意味は ACS の文言表と同じ**", () => {
    expect(startupCodeMeaning("2703")).toBe("Controller description not found.");
    expect(startupCodeMeaning("2777")).toBe("Damaged device description.");
    expect(startupCodeMeaning("8936")).toBe("Security failure on session attempt.");
    expect(startupCodeMeaning("8937")).toBe("Automatic sign-on rejected.");
  });
});

/**
 * **失敗のコードの一覧を固定する**（`20260921-startup-codes-japanese`）。web-ui は同じ一覧の日本語の意味を持つ
 * （`packages/web-ui/src/composables/opMessages.ts` の `STARTUP_CODE_MEANING_JA`。`startup-rejection-ja.test.ts` が同じ一覧で固定）。
 * ここにコードを足したら、日本語の表にも足す——足さないと利用者には「意味の分からない起動応答」と出る
 */
const STARTUP_FAILURE_CODES = [
  "2702", "2703", "2777", "8901", "8902", "8903", "8906", "8907", "8910", "8916", "8917", "8918", "8920", "8921", "8922",
  "8923", "8925", "8928", "8929", "8930", "8934", "8935", "8936", "8937", "8940", "I904"
];
describe("失敗のコードの一覧", () => {
  it("知っているコードから成功を除くと、この一覧（日本語の表と同じ）", () => {
    expect(knownStartupCodes().filter((c) => !STARTUP_SUCCESS_CODES.has(c)).sort()).toEqual([...STARTUP_FAILURE_CODES].sort());
  });
});
