/**
 * **起動応答のコードの表**（`startup-record.ts` から切り出した。`20260921-startup-codes-japanese` の節目の点検の指摘）。
 * 表を CCSID 37 の codec を読み込まない所に置き、ブラウザ入口から一覧を出せるようにした——web-ui の日本語の表
 * （`STARTUP_CODE_MEANING_JA`）と揃っていることを、web-ui のテストがこの一覧と直接比べて固定する（手書きの一覧を 2 つ持たない）。
 */
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
  // ~~"Start-up for device failed."~~ → ACS の文言表（`hod_en` の `KEY_5250_CONNECTION_ERR_8934`）の意味に直した（節目の独立点検の指摘）
  8934: "Start-up for S/36 WSF received.",
  8935: "Session rejected.",
  8940: "Automatic configuration failed or not allowed.",
  I904: "Source system at incompatible release.",
  // **ACS が個別に扱う 4 つ**（`20260921-startup-codes-unknown`）。
  // `DS5250.processStartUpConfirmation` の lookupswitch に個別の分岐として実在し、
  // それぞれ別の通信状態（`ECLSession.SetCommStatus`）へ落ちる——
  // 2703→12 / 2777→13 / 8936→33 / 8937→34。
  // **表に無いと起動応答と認識されず 5250 データとして解析され**、
  // `expected ESC` の警告だけが残って本当の失敗理由が消える（`isKnownStartupCode` はこの表が出所）。
  //
  // ~~⚠ 2703 / 2777 の意味は未確認~~ → ACS の文言表（`acshod2.jar` の `com/ibm/eNetwork/msgs/hod_en` の
  // `KEY_5250_CONNECTION_ERR_2703` / `_2777`）で分かった（`20260921-startup-codes-japanese`）。RFC 4777 の一覧とも同じ意味。
  // ~~8936 は "Automatic sign-on failed."~~ → 同じ表では「セッションの試行でのセキュリティーの失敗」（プリンター側の表と揃った）
  2703: "Controller description not found.",
  2777: "Damaged device description.",
  8936: "Security failure on session attempt.",
  8937: "Automatic sign-on rejected."
};

export function startupCodeMeaning(code: string): string {
  return CODE_MEANING[code] ?? "unknown startup response";
}

/**
 * **既知の起動応答コードか**（`20260802-device-busy-record`）。
 *
 * 起動応答は成功でも失敗でも返る。**失敗のときは装置名が入らない**
 * ——割り当てられていないのだから当然で、`I902` のような成功応答とは長さが違う。
 *
 * そのため「装置名が入っているか」で起動応答を見分けると、**失敗応答を取りこぼす**。
 * 取りこぼすと 5250 のデータストリームとして解析され、`expected ESC, got 0x…` という
 * **こちらの解析器が壊れたように見える警告**だけが残り、本当の理由（`8902` 等）は消える。
 *
 * 見分けは**コードの既知性**で行う。`CODE_MEANING` を唯一の出所にしてあるので、
 * コードを足せば判定も一緒に付いてくる。形の正規表現（`^[A-Z0-9]\d{3}$`）だけより厳しく、
 * 通常のデータストリームを誤って食べる恐れは**増えない**。
 */
export function isKnownStartupCode(code: string): boolean {
  return code in CODE_MEANING;
}

/** 知っている起動応答のコード（web-ui の日本語の表 `STARTUP_CODE_MEANING_JA` と揃っていることをテストで固定する） */
export function knownStartupCodes(): string[] {
  return Object.keys(CODE_MEANING);
}
