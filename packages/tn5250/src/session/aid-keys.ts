import { AID } from "../protocol/constants.js";

/** 対外 API のキー名（spec の AidKey）。SysReq/Attn はヘッダフラグ送信（subtask 02 で対応） */
export type AidKey =
  | "Enter"
  | `F${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24}`
  | "PageUp"
  | "PageDown"
  | "Clear"
  | "Help"
  | "Print"
  | "SysReq"
  | "Attn";

const map = new Map<string, number>([
  ["Enter", AID.ENTER],
  ["PageUp", AID.PAGE_UP],
  ["PageDown", AID.PAGE_DOWN],
  ["Clear", AID.CLEAR],
  ["Help", AID.HELP],
  ["Print", AID.PRINT]
]);
for (let i = 1; i <= 12; i++) map.set(`F${i}`, AID.F1 + (i - 1));
for (let i = 13; i <= 24; i++) map.set(`F${i}`, AID.F13 + (i - 13));

/** AID キー名 → AID コード。SysReq/Attn は AID コードを持たないため undefined */
export function aidCodeOf(key: AidKey): number | undefined {
  return map.get(key);
}

const reverse = new Map<number, AidKey>();
for (const [k, v] of map) reverse.set(v, k as AidKey);

/** AID コード → キー名（GUI 選択肢の AID 解決用）。未知コードは undefined */
export function aidKeyForCode(code: number): AidKey | undefined {
  return reverse.get(code);
}
