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
  /** Record Backspace（AID 0xF8）。ACS はホーム位置で Home を押すと送る（`PS5250.processHome`） */
  | "RecordBackspace"
  /** PA1〜PA3（AID 0x6C・0x6E・0x6B）。ACS は欄データを付けずにカーソルと AID だけを送る（実機の ACS のコア。`20260927-key-edit-rest`） */
  | "PA1"
  | "PA2"
  | "PA3"
  | "SysReq"
  | "Attn"
  /** Test Request（ヘッダのフラグ 0x02・オペコード 0・データ無し。ACS `sendAid` の 61。実機の ACS のワイヤ `… 04 02 00 00`） */
  | "TestRequest";

const map = new Map<string, number>([
  ["Enter", AID.ENTER],
  ["PageUp", AID.PAGE_UP],
  ["PageDown", AID.PAGE_DOWN],
  ["Clear", AID.CLEAR],
  ["Help", AID.HELP],
  ["Print", AID.PRINT],
  ["RecordBackspace", AID.RECORD_BACKSPACE],
  ["PA1", AID.PA1],
  ["PA2", AID.PA2],
  ["PA3", AID.PA3]
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
