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
import type { Codec } from "../codec/codec.js";

export interface StartupResponse {
  /** 例 "I902"（成功）/ "8902"（装置が使用中）。意味は `startupCodeMeaning` */
  code: string;
  /** システム名（例 "PUB400"） */
  system: string;
  /** **実際に割り当てられた**装置名（例 "QPADEV001P"）。対話ジョブのジョブ名でもある */
  device: string;
}

/** 起動応答コード（tn5250 printsession.c）。成功＝セッション確立、他＝失敗 */
export const STARTUP_SUCCESS_CODES: ReadonlySet<string> = new Set(["I901", "I902", "I906"]);

const CODE_MEANING: Record<string, string> = {
  I901: "Virtual device has less function than source device.",
  I902: "Session successfully started.",
  I906: "Automatic sign-on requested, but not allowed. A sign-on screen will follow.",
  2702: "Device description not found.",
  8901: "Device not varied on.",
  8902: "Device not available.",
  8903: "Device not valid for session.",
  8906: "Session initiation failed.",
  8907: "Session failure.",
  8910: "Controller not valid for session.",
  8916: "No matching device found.",
  8917: "Not authorized to object.",
  8918: "Job canceled.",
  8920: "Object partially damaged.",
  8921: "Communications error.",
  8922: "Negative response received.",
  8923: "Startup record built incorrectly.",
  8925: "Creation of device failed.",
  8928: "Change of device failed.",
  8929: "Vary on or vary off failed.",
  8930: "Message queue does not exist.",
  8934: "Start-up for device failed.",
  8935: "Session rejected.",
  8940: "Automatic configuration failed or not allowed.",
  I904: "Source system at incompatible release."
};

export function startupCodeMeaning(code: string): string {
  return CODE_MEANING[code] ?? "unknown startup response";
}

/**
 * 起動応答レコードなら解析する。違えば `undefined`。
 *
 * **判定は応答コードの形で行う**（英字/数字 1 文字＋数字 3 桁）。
 * 通常のデータストリームを誤って食べると画面が出なくなるため、形が合わないものは
 * 起動応答として扱わない。読み位置 `(6 + data[6]) + 5` は tn5250 の `printsession.c:222-235` と同じ。
 */
export function parseStartupResponse(
  record: Uint8Array,
  codec: Codec
): StartupResponse | undefined {
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
    system: full ? codec.decode(record.subarray(at + 9, at + 17)).trim() : "",
    device: full ? codec.decode(record.subarray(at + 17, at + 27)).trim() : ""
  };
}
