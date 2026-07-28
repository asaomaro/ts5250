import type { RejectReason } from "./fieldValidate.js";

/**
 * 操作員メッセージ（クライアント側で出すもの。ホストの `systemMessage` とは別枠）。
 *
 * **日本語で出す。** 元にした ACS の操作員メッセージは英語だが、利用者は日本語の実機
 * （実機）を日本語 UI で使っており、ホスト由来のメッセージ（「機能キーは使用できません。」等）
 * だけが日本語で、こちら発のメッセージだけ英語だと出所の違いが読み手の混乱になる。
 * 対応する ACS 原文は各定数の脇に残す（挙動を突き合わせるときの手がかり）。
 * 文体は `MSG_NO_RESPONSE` に合わせ、です・ます調・句点なしで揃える。
 *
 * **ACS とあえて揃えていない点**: ACS はメッセージがクリアされるまで文字入力を
 * 受け付けないが、本実装は受け付ける（不便なためユーザー判断）。クリア契機も
 * ACS の「ホスト通信 or カーソルキー移動」ではなく任意のキー操作とする。
 *
 * ScreenGrid（欄内）と EmulatorPane（欄外＝保護領域）の両方から使うため、
 * 定数はここに 1 か所だけ置く。**新しい操作員メッセージもここへ足す**——
 * 散らばると翻訳・文体の揃えを取りこぼす。
 */
/** ACS: "Cursor in protected area of display." */
export const MSG_PROTECTED = "カーソルが保護された区域にあるため入力できません";

/** ACS: "No room to insert data."（挿入ペーストが欄に収まらない。何も書き換えない） */
export const MSG_NO_ROOM = "挿入する余地がありません";

/**
 * ホストが応答しないまま待ち時間が尽きたときの通知。
 *
 * Attn / SysReq は**ホストが黙って無視することが正常にあり得る**（ATNPGM が既に前面のとき等）。
 * 無言で待ちを解くと「押したのに何も起きない」が不具合と区別できないので、起きたことを明示する。
 */
export const MSG_NO_RESPONSE = "ホストから応答がありませんでした";

/** 欄の型に合わない文字を弾いたときの理由表示（ACS 原文は各行のコメント）。 */
export const MSG_BY_REASON: Record<RejectReason, string> = {
  // ACS: "Field requires numeric characters."
  numeric: "数字項目には数字しか入力できません",
  // ACS: "Field data must be alphanumeric."
  alphanumeric: "この項目には半角文字しか入力できません",
  // ACS: "Double-byte character required as input."
  "dbcs-required": "この項目には全角文字しか入力できません"
};
