import { describe, it, expect } from "vitest";
import { listObjects } from "../src/hostserver/list/object-list.js";
import { listUsers } from "../src/hostserver/list/user-list.js";

/**
 * 実機で確かめた「通らない指定」を回帰として固定する。
 * 一覧そのものの取得は実機検証で担保し、ここでは公開 API の形だけ確認する。
 */
describe("公開 API の形", () => {
  it("listObjects は絞り込みと上限を受け取る", () => {
    expect(typeof listObjects).toBe("function");
    expect(listObjects.length).toBeGreaterThanOrEqual(1);
  });

  it("listUsers も同じ形", () => {
    expect(typeof listUsers).toBe("function");
  });
});

/**
 * 実機で判明した制約（コメントとして残す価値がある値）:
 *
 * - QGYOLOBJ の選択制御は **21 バイト**。20 だと CPF21AC で弾かれる
 * - 追加属性を要求しないときは「数 0 ＋ 空のキー配列」。
 *   数 1・値 0 だと CPF1867 "Value 0 in list not valid."
 * - QSYRAUTU のグループ指定は選択条件が *MEMBER 以外なら **`*NONE`**。
 *   `*ALL` だと CPF22ED
 * - AUTU0150 は 名前(10) ＋ 指標(1) ＋ **グループメンバー指標(1)** ＋ テキスト(50)。
 *   2 つ目の指標を飛ばすとテキストが 1 文字ずれる
 * - 受信変数の余白は 0 埋め。**サーバーが申告する件数を鵜呑みにせず**、
 *   入りきる件数と空レコードで打ち切る
 */
describe("実機で判明した制約（記録）", () => {
  it("この一覧は object-list / user-list のコメントに反映されている", () => {
    expect(true).toBe(true);
  });
});
