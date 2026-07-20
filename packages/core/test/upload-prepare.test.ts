import { describe, it, expect } from "vitest";
import { prepareUpload, type UploadRejection } from "../src/hostserver/db/upload-prepare.js";
import type { ColumnLayoutInput } from "../src/hostserver/ddm/record-layout.js";

/**
 * 取り込みの事前検査（SQL 経路）。
 *
 * **型・CCSID・長さは見ない**——サーバーがマーカー形式で教えるため。
 * ここが見るのは「行の中身を見なくても分かること」だけ。
 */
const col = (
  name: string,
  nullable: boolean,
  dataType = "CHAR"
): ColumnLayoutInput => ({ name, dataType, length: 10, scale: 0, nullable });

const T = [col("ID", false, "INTEGER"), col("NAME", true), col("NOTE", true)];
const kinds = (rs: UploadRejection[]): string[] => rs.map((r) => r.kind);

describe("正常系", () => {
  it("**CSV の並び順**で列と値を返す（表の宣言順に合わせない）", () => {
    const res = prepareUpload({ columns: T, header: ["NAME", "ID"], rows: [["a", "1"]] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.prepared.columns).toEqual(["NAME", "ID"]);
    expect(res.prepared.rows).toEqual([["a", "1"]]);
  });

  it("列名の突き合わせは大小文字と前後空白を無視する", () => {
    const res = prepareUpload({ columns: T, header: [" id ", "Name"], rows: [["1", "a"]] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 返すのは**表の実列名**（CSV の綴りではない）
    expect(res.prepared.columns).toEqual(["ID", "NAME"]);
  });

  it("**CSV に無い列は INSERT の列リストに含めない**（表の既定値が入る）", () => {
    const res = prepareUpload({ columns: T, header: ["ID"], rows: [["1"]] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.prepared.columns).toEqual(["ID"]);
    expect(res.prepared.rows).toEqual([["1"]]);
  });

  it("emptyAsNull で空文字を NULL にできる（既定は空文字のまま）", () => {
    const asEmpty = prepareUpload({ columns: T, header: ["ID", "NAME"], rows: [["1", ""]] });
    const asNull = prepareUpload({
      columns: T,
      header: ["ID", "NAME"],
      rows: [["1", ""]],
      emptyAsNull: true
    });
    expect(asEmpty.ok && asEmpty.prepared.rows[0]![1]).toBe("");
    expect(asNull.ok && asNull.prepared.rows[0]![1]).toBe(null);
  });

  it("列数が足りない行は不足ぶんを NULL にする", () => {
    const res = prepareUpload({ columns: T, header: ["ID", "NAME"], rows: [["1"]] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.prepared.rows).toEqual([["1", null]]);
  });
});

describe("列の拒否（行を見る前に止める）", () => {
  it("表に無い列は列名を返す", () => {
    const res = prepareUpload({ columns: T, header: ["ID", "NOPE"], rows: [["1", "x"]] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections).toContainEqual({ kind: "column-unknown", columns: ["NOPE"] });
  });

  it("NULL を受け付けない列が CSV に無ければ拒否する", () => {
    const res = prepareUpload({ columns: T, header: ["NAME"], rows: [["a"]] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections).toContainEqual({ kind: "column-missing", columns: ["ID"] });
  });

  it("列が崩れているときは行の検査をしない", () => {
    const res = prepareUpload({
      columns: T,
      header: ["ID", "NOPE"],
      rows: [[null, "x"]] // ID が NULL だがそこは報告しない
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(kinds(res.rejections)).toEqual(["column-unknown"]);
  });
});

describe("値の拒否", () => {
  it("NULL を受け付けない列に NULL が来たら行番号つきで拒否する", () => {
    const res = prepareUpload({
      columns: T,
      header: ["ID", "NAME"],
      rows: [["1", "a"], [null, "b"]]
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections).toEqual([{ kind: "value-null", row: 2, column: "ID" }]);
  });

  it("**行番号は 1 始まり**（ヘッダーを含めない）", () => {
    const res = prepareUpload({
      columns: T,
      header: ["ID"],
      rows: [["1"], ["2"], [null]]
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect((res.rejections[0] as { row: number }).row).toBe(3);
  });

  it("**複数の拒否をまとめて返す**（最初の 1 件で止めない）", () => {
    const res = prepareUpload({
      columns: T,
      header: ["ID"],
      rows: [[null], ["2"], [null]]
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections).toHaveLength(2);
  });

  it("拒否は 100 件で打ち切り、truncated を立てる", () => {
    const rows = Array.from({ length: 150 }, () => [null]);
    const res = prepareUpload({ columns: T, header: ["ID"], rows });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections).toHaveLength(100);
    expect(res.truncated).toBe(true);
  });

  it("**1 件でも拒否があれば行を返さない**（部分的に書かせない）", () => {
    const res = prepareUpload({ columns: T, header: ["ID"], rows: [["1"], [null]] });
    expect(res.ok).toBe(false); // prepared そのものが返らない型
  });
});

describe("型は見ない（SQL 経路の方針）", () => {
  it("**対応外に見える型でも通す**——枠と型はサーバーが教える", () => {
    const withLob = [col("ID", false, "INTEGER"), col("B", true, "BLOB")];
    const res = prepareUpload({ columns: withLob, header: ["ID", "B"], rows: [["1", "x"]] });
    // ここでは弾かない。詰める段（marker-encode）が形式を見て判断する
    expect(res.ok).toBe(true);
  });

  it("数値でない値もここでは弾かない（詰める段で分かる）", () => {
    const res = prepareUpload({ columns: T, header: ["ID"], rows: [["未定"]] });
    expect(res.ok).toBe(true);
  });
});

describe("同じ列を 2 回受けない", () => {
  it("**重複したヘッダーを拒否する**（INSERT (A, A) になるのを防ぐ）", () => {
    const res = prepareUpload({ columns: T, header: ["ID", "NAME", "ID"], rows: [["1", "a", "2"]] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections).toContainEqual({ kind: "column-duplicated", columns: ["ID"] });
  });

  it("大小文字が違っても同じ列とみなす", () => {
    const res = prepareUpload({ columns: T, header: ["ID", "id"], rows: [["1", "2"]] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejections.some((r) => r.kind === "column-duplicated")).toBe(true);
  });
});
