import type { RejectReason } from "./fieldValidate.js";

/**
 * ACS の操作員メッセージ（原文）。クライアント側で出すもので、
 * ホストの `systemMessage` とは別枠。
 *
 * **ACS とあえて揃えていない点**: ACS はメッセージがクリアされるまで文字入力を
 * 受け付けないが、本実装は受け付ける（不便なためユーザー判断）。クリア契機も
 * ACS の「ホスト通信 or カーソルキー移動」ではなく任意のキー操作とする。
 *
 * ScreenGrid（欄内）と EmulatorPane（欄外＝保護領域）の両方から使うため、
 * 定数はここに 1 か所だけ置く。
 */
export const MSG_PROTECTED = "Cursor in protected area of display.";

/**
 * ホストが応答しないまま待ち時間が尽きたときの通知。
 *
 * Attn / SysReq は**ホストが黙って無視することが正常にあり得る**（ATNPGM が既に前面のとき等）。
 * 無言で待ちを解くと「押したのに何も起きない」が不具合と区別できないので、起きたことを明示する。
 */
export const MSG_NO_RESPONSE = "ホストから応答がありませんでした";

export const MSG_BY_REASON: Record<RejectReason, string> = {
  numeric: "Field requires numeric characters.",
  alphanumeric: "Field data must be alphanumeric.",
  "dbcs-required": "Double-byte character required as input."
};
