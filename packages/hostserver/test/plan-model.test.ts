import { describe, it, expect } from "vitest";
import {
  buildQueryPlan,
  buildCreateIndexStatement,
  groupByStatement,
  MONITOR_COLUMNS,
  type MonitorRecord
} from "../src/db/plan-model.js";

/**
 * 実行計画の畳み込み。
 *
 * 固定値は **`20260802-sql-visual-explain` の design 工程で実機(7.3) から実測したもの**
 * （`scripts/research-visual-explain-shapes.mjs`）。ここは変換ロジックの回帰に徹し、
 * 実機との突き合わせは親の統合 test で行う。
 */

const rec = (over: Partial<MonitorRecord> & { QQRID: number }): MonitorRecord => ({
  QQUCNT: 1,
  QQQDTN: 1,
  QQQDTL: 1,
  QQ1000: null,
  QVQTBL: null,
  QVQLIB: null,
  QVINAM: null,
  QVILIB: null,
  QQTOTR: null,
  QQREST: null,
  QQEPT: null,
  QQIDXA: null,
  QQIDXD: null,
  QQRCOD: null,
  QQJOB: null,
  // 既定は「結合していない」。木のテストだけが明示的に入れる
  QQJNP: null,
  QQC21: null,
  QVC14: null,
  QQILNM: null,
  QQI7: null,
  ...over
});

const META = { captured: "run" as const, at: "2026-08-02T00:00:00Z" };

describe("記録種別の写像", () => {
  it("3000 は表の走査、3001 は索引の使用（IBM の文書化された名称に合わせる）", () => {
    const plan = buildQueryPlan(
      [
        rec({ QQRID: 3000, QVQLIB: "QSYS2", QVQTBL: "SYSCOLUMNS", QQTOTR: 669108, QQREST: 5681, QQRCOD: "T3" }),
        rec({ QQRID: 3001, QVQLIB: "QSYS2", QVQTBL: "SYSCOLUMNS", QVINAM: "QADBILLB", QQRCOD: "I1" })
      ],
      META
    );
    const nodes = plan.blocks[0]?.nodes ?? [];
    expect(nodes[0]?.kind).toBe("table-scan");
    expect(nodes[0]?.label).toBe("表の走査: SYSCOLUMNS");
    expect(nodes[0]?.totalRows).toBe(669108);
    expect(nodes[1]?.kind).toBe("index-used");
    expect(nodes[1]?.label).toBe("索引の使用: QADBILLB");
  });

  it("3001 に索引名が無ければ対象表を添える", () => {
    const plan = buildQueryPlan([rec({ QQRID: 3001, QVQLIB: "QTEMP", QVQTBL: "VT1" })], META);
    expect(plan.blocks[0]?.nodes[0]?.label).toBe("索引の使用: VT1");
  });

  it("IBM の文書と実測が一致した種別に名前が付く（抜き取り）", () => {
    const cases: [number, string, string][] = [
      [3003, "sort", "並べ替え"],
      [3015, "statistics", "統計情報"],
      [3023, "temp-hash-table", "一時ハッシュ表の作成"],
      [3025, "distinct", "重複の除去"],
      [3026, "set-operation", "集合演算"],
      [3028, "grouping", "グループ化"]
    ];
    for (const [rid, kind, label] of cases) {
      const node = buildQueryPlan([rec({ QQRID: rid })], META).blocks[0]?.nodes[0];
      expect(node?.kind).toBe(kind);
      expect(node?.label).toBe(label);
    }
  });

  it("**計画のステップと付帯情報を分ける**（図が付帯情報で埋まらないように）", () => {
    const plan = buildQueryPlan(
      [
        rec({ QQRID: 3000, QVQTBL: "T" }), // 表の走査＝ステップ
        rec({ QQRID: 3006 }), // アクセスプランの再作成＝付帯情報
        rec({ QQRID: 3014 }) // クエリ情報＝付帯情報
      ],
      META
    );
    const nodes = plan.blocks[0]?.nodes ?? [];
    expect(nodes.map((n) => n.category)).toEqual(["step", "info", "info"]);
    expect(plan.summary.stepCount).toBe(1);
    expect(plan.summary.nodeCount).toBe(3);
  });

  it("名前を与えていない種別は info に寄せる（意味の分からない箱を計画の流れに混ぜない）", () => {
    const plan = buildQueryPlan([rec({ QQRID: 5002 })], META);
    expect(plan.blocks[0]?.nodes[0]?.category).toBe("info");
  });

  it("**知らない種別に名前を付けない**（5005 は other で、種別番号を出す）", () => {
    // 5005 は観測はしたが、文書化された名称を確認できていない
    const plan = buildQueryPlan([rec({ QQRID: 5005, QQRCOD: "A0" })], META);
    const node = plan.blocks[0]?.nodes[0];
    expect(node?.kind).toBe("other");
    expect(node?.label).toBe("記録 5005");
    expect(node?.recordType).toBe(5005);
  });

  it("未知の種別は unknownRecordTypes に積む（版数差を黙って捨てない）", () => {
    const plan = buildQueryPlan(
      [
        rec({ QQRID: 3000, QVQTBL: "T" }),
        rec({ QQRID: 5002 }),
        rec({ QQRID: 3018 }),
        rec({ QQRID: 5002 })
      ],
      META
    );
    // 重複なし・昇順
    expect(plan.unknownRecordTypes).toEqual([3018, 5002]);
  });

  it("other でも値の入った列は属性に残る（情報を落とさない）", () => {
    const plan = buildQueryPlan([rec({ QQRID: 5002, QQRCOD: "X1", QQTOTR: 7 })], META);
    const attrs = plan.blocks[0]?.nodes[0]?.attributes ?? [];
    // 節（`group`）が付くので、ラベルと値だけを見る
    const pairs = attrs.map((a) => `${a.label}=${a.value}`);
    expect(pairs).toContain("記録種別=5002");
    expect(pairs).toContain("理由コード=X1");
    expect(pairs).toContain("総行数=7");
  });

  /**
   * ACS の詳細ダイアログは 40〜60 項目を出す。その大半は記録種別ごとに意味が変わる列で、
   * ホストの catalog にも説明が無い（実測）。**名前は与えないが、値は全部出す**——
   * 捨てると ACS と突き合わせられなくなる。
   */
  it("名前を与えていない列も**列名のまま**属性に出す（ACS と突き合わせられるように）", () => {
    const plan = buildQueryPlan(
      [rec({ QQRID: 3000, QVQTBL: "T", raw: { QQI3: 344, QQF1: 2676, QVBNDY: "C" } })],
      META
    );
    const attrs = plan.blocks[0]?.nodes[0]?.attributes ?? [];
    // `3000` の `QQI3` は確かめた列なので名前が付く（ACS「テーブル・サイズ」）
    expect(attrs).toContainEqual({
      label: "テーブル・サイズ(バイト)", value: "344", group: "表・索引", column: "QQI3"
    });
    // 確かめていない列は列名のまま、別の節へ。**列の ID は必ず残す**（ACS と突き合わせる）
    expect(attrs).toContainEqual({
      label: "QQF1", value: "2676", group: "モニターの全列", raw: true, column: "QQF1"
    });
    expect(attrs).toContainEqual({
      label: "QVBNDY", value: "C", group: "モニターの全列", raw: true, column: "QVBNDY"
    });
    // **二重に出さない**（名前を付けた列を生の側にも出さない）
    expect(attrs.filter((a) => a.value === "344")).toHaveLength(1);
  });

  it("**同じ列でも記録種別が違えば名前を変える**（`QQI5` は 3001 と 3014 で意味が違う）", () => {
    const asIndex = buildQueryPlan([rec({ QQRID: 3001, raw: { QQI5: 213 } })], META);
    const asInfo = buildQueryPlan([rec({ QQRID: 3014, raw: { QQI5: 9 } })], META);
    // 3001 の QQI5 は名前を与えていない（値の一致が曖昧だった）ので列名のまま
    expect(asIndex.blocks[0]?.nodes[0]?.attributes).toContainEqual({
      label: "QQI5", value: "213", group: "モニターの全列", raw: true, column: "QQI5"
    });
    // 3014 の QQI5 は ACS の「最適化時間」と一意に一致した
    expect(asInfo.blocks[0]?.nodes[0]?.attributes).toContainEqual({
      label: "最適化時間(ミリ秒)", value: "9", group: "見積もり", column: "QQI5"
    });
  });
});

describe("クエリブロック（QQQDTN）", () => {
  it("UNION は 2 ブロックに割れる（実測: dtn=1 と dtn=2）", () => {
    const plan = buildQueryPlan(
      [
        rec({ QQRID: 3000, QQQDTN: 1, QVQTBL: "VT1", QQRCOD: "T1" }),
        rec({ QQRID: 3000, QQQDTN: 2, QVQTBL: "VT2", QQRCOD: "T1" }),
        rec({ QQRID: 3026, QQQDTN: 2 })
      ],
      META
    );
    expect(plan.blocks.map((b) => b.number)).toEqual([1, 2]);
    expect(plan.blocks[1]?.nodes).toHaveLength(2);
    expect(plan.summary.blockCount).toBe(2);
  });

  it("ブロック番号の昇順に並ぶ（記録の到着順に依存しない）", () => {
    const plan = buildQueryPlan(
      [rec({ QQRID: 3000, QQQDTN: 2, QVQTBL: "B" }), rec({ QQRID: 3000, QQQDTN: 1, QVQTBL: "A" })],
      META
    );
    expect(plan.blocks.map((b) => b.number)).toEqual([1, 2]);
  });

  it("ノード id はブロック内で振り直される", () => {
    const plan = buildQueryPlan(
      [
        rec({ QQRID: 3000, QQQDTN: 1, QVQTBL: "A" }),
        rec({ QQRID: 3001, QQQDTN: 1, QVQTBL: "A" }),
        rec({ QQRID: 3000, QQQDTN: 2, QVQTBL: "B" })
      ],
      META
    );
    expect(plan.blocks[0]?.nodes.map((n) => n.id)).toEqual(["1-0", "1-1"]);
    expect(plan.blocks[1]?.nodes.map((n) => n.id)).toEqual(["2-0"]);
  });
});

describe("ノードにしない記録", () => {
  it("3019（文レベルの要約）はノードにならない", () => {
    const plan = buildQueryPlan(
      [rec({ QQRID: 3019, QQQDTL: 0 }), rec({ QQRID: 3000, QVQTBL: "T" })],
      META
    );
    expect(plan.summary.nodeCount).toBe(1);
    expect(plan.blocks[0]?.nodes[0]?.recordType).toBe(3000);
  });

  it("ブロック番号を持たない記録（3018 等）はノードにしない", () => {
    const plan = buildQueryPlan(
      [rec({ QQRID: 3018, QQQDTN: null }), rec({ QQRID: 3000, QVQTBL: "T" })],
      META
    );
    expect(plan.summary.nodeCount).toBe(1);
  });

  it("**ノードにできなくても未対応種別としては記録する**（版数差を黙って消さない）", () => {
    // ブロック番号を持たない記録を落とすと、名前の無い種別が黙って消える
    const plan = buildQueryPlan(
      [rec({ QQRID: 5005, QQQDTN: null }), rec({ QQRID: 3000, QVQTBL: "T" })],
      META
    );
    expect(plan.summary.nodeCount).toBe(1);
    expect(plan.unknownRecordTypes).toContain(5005);
  });

  it("3019 は未対応種別に数えない（意図して要約に回している）", () => {
    const plan = buildQueryPlan([rec({ QQRID: 3019, QQQDTL: 0 }), rec({ QQRID: 3000, QVQTBL: "T" })], META);
    expect(plan.unknownRecordTypes).not.toContain(3019);
  });

  it("1000 も数えない（文テキストの在りかとして意図して使っている）", () => {
    // 数えると**毎回**「未対応の記録種別があります」と出て、版数差の信号が埋もれる
    const plan = buildQueryPlan(
      [rec({ QQRID: 1000, QQ1000: "SELECT 1" }), rec({ QQRID: 3000, QVQTBL: "T" })],
      META
    );
    expect(plan.unknownRecordTypes).not.toContain(1000);
  });
});

describe("索引助言", () => {
  it("3020 かつ QQIDXA='Y' のとき CREATE INDEX 文まで組み立てる", () => {
    const plan = buildQueryPlan(
      [
        rec({
          QQRID: 3020,
          QVQLIB: "QSYS2",
          QVQTBL: "SYSCOLUMNS",
          QQIDXA: "Y",
          QQIDXD: "DBIREL, DBILB2, DBILFI, DBIATR",
          QQTOTR: 669108,
          QQRCOD: "I1"
        })
      ],
      META
    );
    expect(plan.advice).toHaveLength(1);
    expect(plan.advice[0]?.keyColumns).toBe("DBIREL, DBILB2, DBILFI, DBIATR");
    expect(plan.advice[0]?.createStatement).toBe(
      "CREATE INDEX QSYS2.SYSCOLUMNS_IX1 ON QSYS2.SYSCOLUMNS (DBIREL, DBILB2, DBILFI, DBIATR)"
    );
    expect(plan.summary.adviceCount).toBe(1);
  });

  it("QQIDXA が 'N' のときは助言にしない", () => {
    const plan = buildQueryPlan(
      [rec({ QQRID: 3020, QVQTBL: "T", QQIDXA: "N", QQIDXD: "A, B" })],
      META
    );
    expect(plan.advice).toHaveLength(0);
  });

  it("助言キーが無ければ助言にしない（表だけでは CREATE INDEX を作れない）", () => {
    const plan = buildQueryPlan([rec({ QQRID: 3020, QVQTBL: "T", QQIDXA: "Y", QQIDXD: null })], META);
    expect(plan.advice).toHaveLength(0);
  });

  it("複数の助言は連番で索引名が衝突しない", () => {
    const plan = buildQueryPlan(
      [
        rec({ QQRID: 3020, QVQLIB: "L", QVQTBL: "T", QQIDXA: "Y", QQIDXD: "A" }),
        rec({ QQRID: 3020, QVQLIB: "L", QVQTBL: "T", QQIDXA: "Y", QQIDXD: "B" })
      ],
      META
    );
    expect(plan.advice.map((a) => a.createStatement)).toEqual([
      "CREATE INDEX L.T_IX1 ON L.T (A)",
      "CREATE INDEX L.T_IX2 ON L.T (B)"
    ]);
  });

  it("長い表名は索引名で 18 文字に切る（名前が長すぎて弾かれないように）", () => {
    const s = buildCreateIndexStatement({ schema: "S", name: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" }, "K", 1);
    expect(s).toBe("CREATE INDEX S.ABCDEFGHIJKLMNOPQR_IX1 ON S.ABCDEFGHIJKLMNOPQRSTUVWXYZ (K)");
  });

  it("キー列の余分な空白を落とす", () => {
    expect(buildCreateIndexStatement({ schema: "", name: "T" }, " A ,  B ,, ", 1)).toBe(
      "CREATE INDEX T_IX1 ON T (A, B)"
    );
  });
});

describe("要約", () => {
  it("表・索引は重複なし、推定時間は最大値", () => {
    const plan = buildQueryPlan(
      [
        rec({ QQRID: 3000, QVQLIB: "L", QVQTBL: "T", QQEPT: 5 }),
        rec({ QQRID: 3001, QVQLIB: "L", QVQTBL: "T", QVINAM: "IX", QQEPT: 12 }),
        rec({ QQRID: 3001, QVQLIB: "L", QVQTBL: "T", QVINAM: "IX", QQEPT: 3 })
      ],
      META
    );
    expect(plan.summary.tables).toEqual(["L.T"]);
    expect(plan.summary.indexes).toEqual(["IX"]);
    expect(plan.summary.maxEstimatedMs).toBe(12);
    expect(plan.summary.nodeCount).toBe(3);
  });

  it("推定時間が 1 件も無ければ maxEstimatedMs を付けない", () => {
    const plan = buildQueryPlan([rec({ QQRID: 3000, QVQTBL: "T" })], META);
    expect(plan.summary.maxEstimatedMs).toBeUndefined();
  });

  it("elapsedMs は呼び出し側から受け取る（純関数に時計を持ち込まない）", () => {
    const plan = buildQueryPlan([rec({ QQRID: 3000, QVQTBL: "T" })], { ...META, elapsedMs: 42 });
    expect(plan.summary.elapsedMs).toBe(42);
  });
});

describe("文テキストとジョブ", () => {
  it("一番長い QQ1000 を文とする（3010 のホスト変数値を文と取り違えない）", () => {
    const plan = buildQueryPlan(
      [
        rec({ QQRID: 3010, QQ1000: "'QSYS2', 'X'" }),
        rec({ QQRID: 3000, QVQTBL: "T", QQ1000: "SELECT COUNT(*) FROM QSYS2.SYSCOLUMNS WHERE X = 1" })
      ],
      META
    );
    expect(plan.statement).toBe("SELECT COUNT(*) FROM QSYS2.SYSCOLUMNS WHERE X = 1");
  });

  it("呼び出し側が文を指定すればそちらを優先する", () => {
    const plan = buildQueryPlan([rec({ QQRID: 3000, QQ1000: "AAA" })], { ...META, statement: "SELECT 1" });
    expect(plan.statement).toBe("SELECT 1");
  });

  it("ジョブ名を拾う", () => {
    const plan = buildQueryPlan([rec({ QQRID: 3000, QVQTBL: "T", QQJOB: "082044/QUSER/QZDASOINIT" })], META);
    expect(plan.job).toBe("082044/QUSER/QZDASOINIT");
  });
});

describe("文ごとの切り分け", () => {
  it("QQUCNT でまとめる（一覧から計画を開く導線が 2 段目の CALL を要らなくする）", () => {
    const g = groupByStatement([
      rec({ QQRID: 3000, QQUCNT: 10 }),
      rec({ QQRID: 3001, QQUCNT: 10 }),
      rec({ QQRID: 3000, QQUCNT: 20 })
    ]);
    expect([...g.keys()]).toEqual([10, 20]);
    expect(g.get(10)).toHaveLength(2);
  });

  it("QQUCNT が無い記録は捨てる", () => {
    const g = groupByStatement([rec({ QQRID: 3018, QQUCNT: null })]);
    expect(g.size).toBe(0);
  });
});

describe("読み出す列", () => {
  it("MONITOR_COLUMNS は MonitorRecord のキーと一致する（SELECT * を使わないための単一の真実）", () => {
    const keys = Object.keys(rec({ QQRID: 0 })).sort();
    expect([...MONITOR_COLUMNS].sort()).toEqual(keys);
  });
});

/**
 * 結合の木。**`QQJNP`（ダイヤル）1 列で決まる**——2 表で 1・2、3 表で 1・2・3 になるのを
 * 実機 7.3 で実測した（`design.md` A1 の訂正）。
 */
describe("結合の木", () => {
  const joined = (over: Partial<MonitorRecord> & { QQRID: number }) =>
    rec({ QQC21: "NL", ...over });

  it("2 つのダイヤルを左深に組む（ACS と同じ読み方になる）", () => {
    const plan = buildQueryPlan(
      [
        joined({ QQRID: 3000, QQJNP: 1, QVQLIB: "TESTLIB", QVQTBL: "M_MENUTR" }),
        joined({ QQRID: 3001, QQJNP: 2, QVQLIB: "TESTLIB", QVQTBL: "M_MENU" })
      ],
      META
    );
    const tree = plan.blocks[0]?.joinTree;
    expect(tree?.kind).toBe("join");
    if (tree?.kind !== "join") return;
    expect(tree.left.kind).toBe("dial");
    expect(tree.right.kind).toBe("dial");
    if (tree.left.kind === "dial") expect(tree.left.position).toBe(1);
    if (tree.right.kind === "dial") expect(tree.right.position).toBe(2);
  });

  it("3 つ以上は左深に重なる（((1 ⋈ 2) ⋈ 3)）", () => {
    const plan = buildQueryPlan(
      [
        joined({ QQRID: 3000, QQJNP: 1 }),
        joined({ QQRID: 3001, QQJNP: 2 }),
        joined({ QQRID: 3001, QQJNP: 3 })
      ],
      META
    );
    const root = plan.blocks[0]?.joinTree;
    expect(root?.kind).toBe("join");
    if (root?.kind !== "join") return;
    // 根の右は最後のダイヤル、左はさらに結合
    if (root.right.kind === "dial") expect(root.right.position).toBe(3);
    expect(root.left.kind).toBe("join");
  });

  it("**実測した `NL` にだけ名前を付ける**（知らないコードは名乗らせない）", () => {
    const nl = buildQueryPlan(
      [joined({ QQRID: 3000, QQJNP: 1 }), joined({ QQRID: 3001, QQJNP: 2 })],
      META
    ).blocks[0]?.joinTree;
    expect(nl?.kind === "join" && nl.label).toBe("ネステッドループ結合");

    const unknown = buildQueryPlan(
      [rec({ QQRID: 3000, QQJNP: 1, QQC21: "XX" }), rec({ QQRID: 3001, QQJNP: 2, QQC21: "XX" })],
      META
    ).blocks[0]?.joinTree;
    expect(unknown?.kind === "join" && unknown.label).toBe("結合（XX）");
  });

  it("ダイヤルが 1 つなら木にしない（単表の見え方を変えない）", () => {
    const plan = buildQueryPlan([joined({ QQRID: 3000, QQJNP: 1 })], META);
    expect(plan.blocks[0]?.joinTree).toBeUndefined();
  });

  it("結合していない計画には木が付かない", () => {
    const plan = buildQueryPlan([rec({ QQRID: 3000 }), rec({ QQRID: 3001 })], META);
    expect(plan.blocks[0]?.joinTree).toBeUndefined();
  });

  /** `3007`（オプティマイザの打ち切り）が `QQJNP=0` を返すのを実測している */
  it("**`QQJNP=0` は「参加していない」**——ダイヤル 0 を作らない", () => {
    const plan = buildQueryPlan(
      [
        joined({ QQRID: 3000, QQJNP: 1 }),
        joined({ QQRID: 3001, QQJNP: 2 }),
        joined({ QQRID: 3007, QQJNP: 0 })
      ],
      META
    );
    const tree = plan.blocks[0]?.joinTree;
    expect(tree?.kind === "join" && tree.left.kind === "dial" && tree.left.position).toBe(1);
    // 0 のノードはダイヤルに入らない（属性にも出さない）
    const timeout = plan.blocks[0]?.nodes.find((n) => n.recordType === 3007);
    expect(timeout?.joinPosition).toBeUndefined();
    expect(timeout?.attributes.some((a) => a.label === "結合位置")).toBe(false);
  });

  it("同じダイヤルの記録はまとまる（副問合せが結合へ書き換わる形）", () => {
    const plan = buildQueryPlan(
      [
        joined({ QQRID: 3000, QQJNP: 1 }),
        joined({ QQRID: 3023, QQJNP: 1 }),
        joined({ QQRID: 3001, QQJNP: 2 })
      ],
      META
    );
    const tree = plan.blocks[0]?.joinTree;
    expect(tree?.kind === "join" && tree.left.kind === "dial" && tree.left.nodes).toHaveLength(2);
  });

  it("付帯情報は木の節にしない（`3014` などが枝に混ざらない）", () => {
    const plan = buildQueryPlan(
      [
        joined({ QQRID: 3000, QQJNP: 1 }),
        joined({ QQRID: 3001, QQJNP: 2 }),
        joined({ QQRID: 3014, QQJNP: 1 })
      ],
      META
    );
    const tree = plan.blocks[0]?.joinTree;
    expect(tree?.kind === "join" && tree.left.kind === "dial" && tree.left.nodes).toHaveLength(1);
  });
});

/**
 * ACS の Visual Explain には出ていて、記録には直接無いもの。
 * どちらも**記録から導ける**ことを実機で確かめてある（`design.md` の 4.）。
 */
describe("導いた節（テーブル・プローブ／最終選択）", () => {
  const dial = (over: Partial<MonitorRecord> & { QQRID: number }) => rec({ QQC21: "NL", ...over });

  it("索引だけで足りないダイヤルの後ろにテーブル・プローブを挟む（`QVC14='N'`）", () => {
    const plan = buildQueryPlan(
      [
        dial({ QQRID: 3000, QQJNP: 1, QVQLIB: "TESTLIB", QVQTBL: "M_MENUTR" }),
        dial({ QQRID: 3001, QQJNP: 2, QVQLIB: "TESTLIB", QVQTBL: "M_MENU", QVC14: "N" })
      ],
      META
    );
    const root = plan.blocks[0]?.joinTree;
    expect(root?.kind).toBe("op");
    if (root?.kind !== "op") return;
    expect(root.op).toBe("table-probe");
    expect(root.label).toBe("テーブル・プローブ: M_MENU");
    expect(root.source.kind).toBe("join");
  });

  it("**索引だけで足りるなら挟まない**（`QVC14='Y'`）", () => {
    const plan = buildQueryPlan(
      [
        dial({ QQRID: 3000, QQJNP: 1 }),
        dial({ QQRID: 3001, QQJNP: 2, QVQLIB: "TESTLIB", QVQTBL: "M_MENU", QVC14: "Y" })
      ],
      META
    );
    expect(plan.blocks[0]?.joinTree?.kind).toBe("join");
  });

  it("`3019` の QQI7 から最終選択を根に載せる（ACS の「最終選択」の数字）", () => {
    const plan = buildQueryPlan(
      [
        dial({ QQRID: 3000, QQJNP: 1 }),
        dial({ QQRID: 3001, QQJNP: 2 }),
        rec({ QQRID: 3019, QQQDTN: 1, QQI7: 8 })
      ],
      META
    );
    const root = plan.blocks[0]?.joinTree;
    expect(root?.kind === "op" && root.op).toBe("final-select");
    expect(root?.kind === "op" && root.rows).toBe(8);
    // 要約そのものはノードにしないまま（従来どおり）
    expect(plan.blocks[0]?.nodes.some((n) => n.recordType === 3019)).toBe(false);
  });

  it("行数が採れなければ最終選択を出さない（無い数字を空欄で見せない）", () => {
    const plan = buildQueryPlan([dial({ QQRID: 3000, QQJNP: 1 }), dial({ QQRID: 3001, QQJNP: 2 })], META);
    expect(plan.blocks[0]?.joinTree?.kind).toBe("join");
  });

  it("索引名は `QQ1000` のアクセスパス名を使う（ACS と同じ名前になる）", () => {
    const plan = buildQueryPlan(
      [rec({ QQRID: 3001, QVQLIB: "TESTLIB", QVQTBL: "M_MENU", QVINAM: "M_MENU", QVILIB: "TESTLIB", QQILNM: "TESTLIB", QQ1000: "Q_TESTLIB_M_MENU_MENUCD_00001" })],
      META
    );
    const node = plan.blocks[0]?.nodes[0];
    expect(node?.index?.name).toBe("Q_TESTLIB_M_MENU_MENUCD_00001");
    expect(node?.label).toBe("索引の使用: Q_TESTLIB_M_MENU_MENUCD_00001");
  });

  it("`QQ1000` が空なら `QVINAM` に落とす（QSYS2 の表で実測）", () => {
    const plan = buildQueryPlan([rec({ QQRID: 3001, QVINAM: "QADBILLB", QVILIB: "QSYS" })], META);
    expect(plan.blocks[0]?.nodes[0]?.index?.name).toBe("QADBILLB");
  });
});

/**
 * ホストの catalog から取れた論理名を見出しに使う。
 * 取れない列（`QQI9` 等）は**列名のまま**——どこにも論理名が無いので推測しない。
 */
describe("列の論理名", () => {
  const labels = new Map([
    ["QQTFN", "照会されたテーブルの名前"],
    ["QQF1", "処理時間"]
  ]);

  it("catalog の論理名を見出しにし、列の ID も残す", () => {
    const plan = buildQueryPlan(
      [rec({ QQRID: 3000, QVQTBL: "T", raw: { QQTFN: "M_MENUTR", QQI9: 183 } })],
      { ...META, columnLabels: labels }
    );
    const attrs = plan.blocks[0]?.nodes[0]?.attributes ?? [];
    expect(attrs).toContainEqual({
      label: "照会されたテーブルの名前",
      value: "M_MENUTR",
      group: "モニターの全列",
      raw: true,
      column: "QQTFN"
    });
    // 論理名が無い列は列名のまま
    expect(attrs).toContainEqual({
      label: "QQI9", value: "183", group: "モニターの全列", raw: true, column: "QQI9"
    });
  });

  it("論理名が無くても壊れない（引けなかったホストでも計画は出る）", () => {
    const plan = buildQueryPlan([rec({ QQRID: 3000, QVQTBL: "T", raw: { QQTFN: "X" } })], META);
    expect(plan.blocks[0]?.nodes[0]?.attributes).toContainEqual({
      label: "QQTFN", value: "X", group: "モニターの全列", raw: true, column: "QQTFN"
    });
  });
});
