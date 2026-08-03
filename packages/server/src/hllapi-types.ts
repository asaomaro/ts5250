/**
 * HLLAPI / EHLLAPI の語彙——**機能番号と戻り値**。
 *
 * 出典は **SunLink SNA 3270 9.1 EHLLAPI Programmer's Manual**（Sun Microsystems, 1997。
 * Part No. 802-2668-12）の 3.6 / 4 章。`20260803-hllapi-bridge` の research F2 / F3 で
 * PDF を直読みして写した。**推測で番号を決めていない**——番号が 1 つ違えば既存資産が動かない。
 *
 * 実装ごとに名前が違う（Sun は `hllc`、IBM PCOMM の Windows 版は `hllapi` / `WinHLLAPI`）が、
 * **機能番号と戻り値は共通**。
 */

/** HLLAPI の機能番号（research F2） */
export const HF = {
  CONNECT_PS: 1,
  DISCONNECT_PS: 2,
  SEND_KEY: 3,
  WAIT: 4,
  COPY_PS: 5,
  SEARCH_PS: 6,
  QUERY_CURSOR_LOCATION: 7,
  COPY_PS_TO_STRING: 8,
  SET_SESSION_PARAMETERS: 9,
  QUERY_SESSIONS: 10,
  RESERVE: 11,
  RELEASE: 12,
  COPY_OIA: 13,
  QUERY_FIELD_ATTRIBUTE: 14,
  COPY_STRING_TO_PS: 15,
  PAUSE: 18,
  QUERY_SYSTEM: 20,
  RESET_SYSTEM: 21,
  QUERY_SESSION_STATUS: 22,
  QUERY_HOST_UPDATE: 24,
  STOP_HOST_NOTIFICATION: 25,
  SEARCH_FIELD: 30,
  FIND_FIELD_POSITION: 31,
  FIND_FIELD_LENGTH: 32,
  COPY_STRING_TO_FIELD: 33,
  COPY_FIELD_TO_STRING: 34,
  SET_CURSOR: 40,
  START_KEYSTROKE_INTERCEPT: 50,
  GET_KEY: 51,
  POST_INTERCEPT_STATUS: 52,
  STOP_KEYSTROKE_INTERCEPT: 53,
  SEND_FILE: 90,
  RECEIVE_FILE: 91,
  CONVERT_POS_ROWCOL: 99
} as const;

/**
 * ⚠ **`Start Host Notification` の番号はここに入れていない。**
 *
 * 一次資料の目次が `\32\` と書いているが、`Find Field Length` も `\32\` で衝突する
 * （research F2）。IBM の正典では 23（23/24/25 が Start/Query/Stop の三つ組）と思われるが、
 * **確かめていない**。本作業の対象外なので、**推測で番号を置かずに未実装のまま**にする。
 * 実装するときに改めて一次資料で確かめること。
 */

/** HLLAPI の戻り値（research F3。3.6 Return Codes） */
export const HRC = {
  /** 成功／更新なし */
  SUCCESSFUL: 0,
  /** 指定された PS が無効 */
  PS_ID_INVALID: 1,
  /** パラメータの誤り、または無効な機能 */
  PARAMETER_ERROR: 2,
  /** PS がビジー */
  PS_BUSY: 4,
  /** PS がロックされている */
  FUNCTION_INHIBITED: 5,
  /** 警告。長さが合わず切り詰めた可能性 */
  DATA_ERROR: 6,
  /** PS 上の位置が無効（検索で見つからない場合もこれ） */
  PS_POSITION_INVALID: 7,
  /** 呼ぶ順序が違う（接続していないのに操作した等） */
  PROCEDURE_ERROR: 8,
  /** システムエラー */
  SYSTEM_ERROR: 9,
  /** **利用不可または未知の機能**。未実装はこれで断る */
  FUNCTION_UNAVAILABLE: 10,
  /** 他のアプリが既に接続している */
  RESOURCE_UNAVAILABLE: 11,
  /** 未定義のキー組み合わせ */
  UNDEFINED_COMBINATION: 20,
  /** OIA が更新された */
  OIA_UPDATED: 21,
  /** PS が更新された */
  PS_ONLY_UPDATED: 22,
  /** PS と OIA の両方が更新された */
  PS_OIA_UPDATED: 23,
  /** PS が欄で構成されていない */
  PS_UNFORMATTED: 24,
  /** Pause の途中で更新があった */
  PS_UPDATED: 26,
  /** 欄の長さが 0 */
  FIELD_ZERO_LENGTH: 28
} as const;

/**
 * ブリッジが受け取る 1 呼び出し。
 *
 * HLLAPI の 4 引数（`function` / `data_string` / `length` / `return_code`）に対応する。
 * **`pos` は入力時の `return_code`**——HLLAPI の規約では、機能によってここが
 * PS 上の位置を運ぶ（research F1）。
 */
export interface HllapiRequest {
  function: number;
  /**
   * 呼び出し側のバッファの中身を **CP932 のバイト列**として base64 にしたもの。
   *
   * **文字列で運ばない。** HLLAPI の PS は 1 位置 = 1 バイトで、全角は 2 バイト（＝2 桁）。
   * 文字列に直すと桁とバイトの対応が崩れ、日本語画面で位置が全部ずれる
   * （`hllapi-ps.ts` の注記）。
   */
  dataB64: string;
  length: number;
  pos: number;
}

export interface HllapiResponse {
  rc: number;
  /** 呼び出し側のバッファへ書き戻す **CP932 バイト列**の base64（無い機能もある） */
  dataB64?: string;
  /** 書き戻すバイト数 */
  length?: number;
}
