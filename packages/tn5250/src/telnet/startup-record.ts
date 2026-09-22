/**
 * 起動応答レコード（Startup Response Record・RFC 4777 §10）。
 *
 * 5250 の交渉が終わると、ホストは**仮想装置の電源投入結果**を 1 レコード返す
 * （`IBMSENDCONFREC=YES` を申告した端末に対して。`telnet.ts` が申告している）。
 * 中身は **応答コード 4 ／ システム名 8 ／ 実際に割り当てられた装置名 10**（いずれも EBCDIC）。
 *
 * **表示セッションでも来る**——装置名を指定せずホストに採番させた場合でも、
 * ここで実際の装置名（`QPADEV001P` 等）が分かる。対話ジョブのジョブ名は装置名と同じなので、
 * 画面に一切触れずにジョブ名を知る唯一の経路になる（20260723-session-job-info-rework の research F1）。
 *
 * 実機（PUB400）で捕えた 1 レコード目:
 *
 * ```
 * 00 49 12 a0 90 00 05 60 06 00 20 c0 00 3d 00 00
 * c9 f9 f0 f2                                      ← "I902"
 * d7 e4 c2 f4 f0 f0 40 40                          ← "PUB400  "
 * d8 d7 c1 c4 c5 e5 f0 f0 f1 d7                    ← "QPADEV001P"
 * ```
 */
import { codecForCcsid } from "@ts5250/ebcdic";

/**
 * **起動応答は CCSID 37 で読む**（ACS `DS5250.processStartUpConfirmation` は `new CodePage(37, 2)` で名前を取り出す。
 * `20260921-startup-record-cp037`）。~~セッションの codec で読む~~——930 / 5026（SBCS は 290）では 0x5B が `¥` になり、
 * `$` を含む装置名・システム名が化けた（装置名はスプール救出の OUTQ にも使う）
 */
const CP037 = codecForCcsid(37);

export interface StartupResponse {
  /** 例 "I902"（成功）/ "8902"（装置が使用中）。意味は `startupCodeMeaning` */
  code: string;
  /** システム名（例 "PUB400"） */
  system: string;
  /** **実際に割り当てられた**装置名（例 "QPADEV001P"）。対話ジョブのジョブ名でもある */
  device: string;
}

// コードの表は `startup-codes.ts`（codec を読み込まない所。ブラウザ入口から一覧を出すため）
export { STARTUP_SUCCESS_CODES, startupCodeMeaning, isKnownStartupCode, knownStartupCodes } from "./startup-codes.js";

/**
 * 起動応答レコードなら解析する。違えば `undefined`。
 *
 * **判定は応答コードの形で行う**（英字/数字 1 文字＋数字 3 桁）。
 * 通常のデータストリームを誤って食べると画面が出なくなるため、形が合わないものは
 * 起動応答として扱わない。読み位置 `(6 + data[6]) + 5` は tn5250 の `printsession.c:222-235` と同じ。
 */
export function parseStartupResponse(record: Uint8Array): StartupResponse | undefined {
  const codec = CP037;
  const at = 6 + (record[6] ?? 4);
  if (at + 9 > record.length) return undefined;
  const code = codec.decode(record.subarray(at + 5, at + 9));
  if (!/^[A-Z0-9]\d{3}$/.test(code)) return undefined;
  // **システム名と装置名は「あれば読む」**。実機は必ず付けてくるが、
  // 応答コードだけの短いレコードでも接続可否の判断（プリンター）は成立する。
  // 呼び出し側は「装置名が要るか」を自分の都合で判断すればよい
  const full = at + 27 <= record.length;
  return {
    code,
    system: full ? nameOf(record.subarray(at + 9, at + 17)) : "",
    device: full ? nameOf(record.subarray(at + 17, at + 27)) : ""
  };
}

/**
 * 名前の欄を読む。**末尾の 0x00 と 0x40 だけを落としてから**復号する（ACS `DS5250.extractNameFromStartUpConfirmationRecord`。
 * ~~復号してから `trim()`~~——NUL で詰めるホストだと NUL が残り、先頭の空白は逆に落としていた。`20260921-startup-record-cp037` の節目の点検の懸念）
 */
function nameOf(bytes: Uint8Array): string {
  let n = bytes.length;
  while (n > 0 && (bytes[n - 1] === 0x00 || bytes[n - 1] === 0x40)) n--;
  return CP037.decode(bytes.subarray(0, n));
}
