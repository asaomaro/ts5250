/**
 * AID（Attention IDentifier）コード。
 *
 * **すべて実測で確定した**（`artifacts/aid.trc`）。手法は 02 と逆向きで、
 * `mini3270` を受信側に立てて `s3270` に各キーを押させ、送ってきたバイトを捕まえた。
 * 29 個すべてを総当たりしてある（推測で埋めた値は無い）。
 */

export type AidKey =
  | "enter"
  | "clear"
  | "pa1"
  | "pa2"
  | "pa3"
  | `pf${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12}`
  | `pf${13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24}`;

/** キー名 → AID コード（実測値） */
export const AID: Readonly<Record<AidKey, number>> = {
  enter: 0x7d,
  pf1: 0xf1,
  pf2: 0xf2,
  pf3: 0xf3,
  pf4: 0xf4,
  pf5: 0xf5,
  pf6: 0xf6,
  pf7: 0xf7,
  pf8: 0xf8,
  pf9: 0xf9,
  pf10: 0x7a,
  pf11: 0x7b,
  pf12: 0x7c,
  pf13: 0xc1,
  pf14: 0xc2,
  pf15: 0xc3,
  pf16: 0xc4,
  pf17: 0xc5,
  pf18: 0xc6,
  pf19: 0xc7,
  pf20: 0xc8,
  pf21: 0xc9,
  pf22: 0x4a,
  pf23: 0x4b,
  pf24: 0x4c,
  pa1: 0x6c,
  pa2: 0x6e,
  pa3: 0x6b,
  clear: 0x6d
};

/**
 * ホスト起動の読み取り（`Read Modified` / `Read Buffer` コマンド）への応答に使う AID。
 * 実測: RM コマンドへの応答が `60 …` で始まった（キー押下ではないので「AID 無し」の意）。
 */
export const AID_NONE = 0x60;

const BY_CODE = new Map<number, AidKey>(
  (Object.entries(AID) as [AidKey, number][]).map(([k, v]) => [v, k])
);

export function aidCodeOf(key: AidKey): number {
  return AID[key];
}

export function aidKeyForCode(code: number): AidKey | undefined {
  return BY_CODE.get(code);
}

/**
 * **カーソルアドレスもフィールドデータも送らない短形式のキー。**
 *
 * 実測（`aid.trc`）: `PA1`=`6c` / `PA2`=`6e` / `PA3`=`6b` / `Clear`=`6d` は
 * **AID 1 バイトだけ**で送られた。他のキーは必ず `AID + カーソル 2 バイト` を伴う。
 * これは仕様書の記述より狭い——`spec.md` には「AID とカーソルアドレスのみ」と書いたが、
 * **実測ではカーソルアドレスすら無い**。実測を正とする。
 */
export function isShortForm(key: AidKey): boolean {
  return key === "pa1" || key === "pa2" || key === "pa3" || key === "clear";
}
