import { z } from "zod";
import { As400Error } from "@ts5250/base";
import type { WsFieldRef } from "./ws-messages.js";

/**
 * **ws の `fields[].field` を実行時に確かめる。**
 *
 * `WsConnection.handle()` は `JSON.parse(raw) as WsClientMessage` で**型を名乗らせているだけ**なので、
 * ここへは任意の JSON が届く。検証せずに先へ渡すと 2 通りに壊れる（どちらも実測）:
 *
 * - **5250**: `Session.resolveField` の `"index" in target` が
 *   `TypeError: Cannot use 'in' operator to search for 'index' in <クライアントの文字列>` を投げ、
 *   `ws-handler` の catch が**そのままクライアントへ返す**
 * - **3270**: `applyFields` の `ref.row` が `undefined` になって欄が見つからず、
 *   `no field at ${JSON.stringify(ref)}` として**クライアントの値がそのまま返る**
 *
 * どちらも `20260920-field-error-no-value` の review で見つかった（decisions D8）。
 * **5250 と 3270 で別々に書かない**——片方だけ直る事故を防ぐため、検証をここ 1 か所に置いて
 * 両方の入口から呼ぶ（条項 `paired-artifact-sync`。実際 3270 側は 1 ラウンド遅れて見つかった）。
 *
 * **`ws-messages.ts` には置けない**——あのファイルは web-ui が `import type` する型専用で、
 * zod を入れるとブラウザのバンドルに実行時コードが載る（`AGENTS.md`「パッケージ分割と入口」）。
 */
export const wsFieldRefSchema: z.ZodType<WsFieldRef> = z.union([
  z.number().int().positive(),
  z.strictObject({ row: z.number().int().positive(), col: z.number().int().positive() })
]);

/**
 * 欄の指定を検証して返す。**弾くときは中身を文言に出さない**
 * ——`code` が種別を伝えており、どの欄を指したかは指した側が知っている
 * （`20260920-field-error-no-value` decisions D3）。
 */
export function parseFieldRef(raw: unknown): WsFieldRef {
  const parsed = wsFieldRefSchema.safeParse(raw);
  if (!parsed.success) throw new As400Error("PROTOCOL_ERROR", "invalid field reference");
  return parsed.data;
}

/**
 * **`fields[]` の 1 要素そのものを確かめる。**
 *
 * `field` を見る前に、**要素が物であること**から確かめないと意味がない——
 * `"value" in f` / `"index" in f` は `f` がプリミティブだと
 * `TypeError: Cannot use 'in' operator to search for 'value' in <その値>` を投げ、
 * **クライアントの文字列がそのまま文言に載る**（`20260920-field-error-no-value` review ラウンド 3 で実測。
 * `fields: ["LEAK_MARKER_XYZ"]` で再現した）。
 *
 * **ラウンド 2 で検証を 1 か所へ寄せたのに、3270 側は `in` の判定を検証より前に置いていた**ので
 * 半分しか閉じていなかった。**同じ関数を呼ぶだけでは足りず、呼ぶ位置まで揃える**必要がある
 * ——だから「形の検査」と「`field` の検査」をこの 1 つにまとめ、**最初に呼ぶ**形にした。
 */
export function parseKeyFieldShape(f: unknown): { field: WsFieldRef; hasValue: boolean } {
  if (typeof f !== "object" || f === null || Array.isArray(f)) {
    throw new As400Error("PROTOCOL_ERROR", "invalid field entry");
  }
  const rec = f as Record<string, unknown>;
  return { field: parseFieldRef(rec["field"]), hasValue: "value" in rec };
}

/**
 * **`fields` の容れ物**。要素は `parseKeyFieldShape` で守ったが、
 * **配列そのもの**は素通しだった（`20260920-field-error-no-value` review ラウンド 4 で実測）:
 * `{"type":"key","fields":"LEAK…"}` は 5250 で `fields.map is not a function` を
 * **素の V8 の文言のまま**返し、3270 では文字列を 1 文字ずつ回っていた
 * ——**同じ入力に 5250 と 3270 が別の答えを返す**状態だった。
 */
export function parseKeyFields(raw: unknown): readonly unknown[] {
  if (!Array.isArray(raw)) throw new As400Error("PROTOCOL_ERROR", "fields must be an array");
  return raw;
}

/**
 * GUI 選択欄の id。**`fields[].field` と同じ理由で境界で確かめる**
 * ——`handle()` は型を名乗らせているだけなので、`gui-select` / `gui-submit` の
 * `fieldId` にも任意の JSON が届く（`20260920-field-error-no-value` review ラウンド 3）。
 */
export function parseFieldId(raw: unknown): number {
  // **`wsFieldRefSchema` の `.int().positive()` に揃える**——「欄の指し方を 1 か所で決める」
  // モジュールの中で識別子の定義が割れていた（review ラウンド 4）
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new As400Error("PROTOCOL_ERROR", "invalid fieldId");
  }
  return raw;
}

/** 欄へ書く値。文字列でないと `setField` / `type()` の中で素の TypeError になる */
export function parseFieldValue(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new As400Error("PROTOCOL_ERROR", "field value must be a string");
  }
  return raw;
}
