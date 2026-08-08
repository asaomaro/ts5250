import { describe, it, expect, vi } from "vitest";
import { capturePlan, monitorTableName } from "../src/db/plan-capture.js";
import { buildQueryPlan, pickStatementRecords, type MonitorRecord } from "../src/db/plan-model.js";
import { As400Error } from "@ts5250/base";
import type { DbConnection } from "../src/db/db-connection.js";

/**
 * 採取手順の**不変条件**を固定する。
 *
 * `20260802-sql-visual-explain` の spec/design で決めた 3 つ:
 *
 * 1. `STRDBMON` が失敗したら**文を実行しない**（計画が採れないのに副作用だけ起こさない）
 * 2. `ENDDBMON` は**文が失敗しても必ず通る**（モニターを残さない）
 * 3. QTEMP の表は**どの経路を通っても `DROP` する**
 *
 * 実機での確認は親の統合 test。ここは手順そのものの回帰に徹する。
 */

const CP_SQLCA = 0x3807;
const CP_SUPER_EXTENDED_FORMAT = 0x3812;

function sqlcaOk(): Uint8Array {
  const out = new Uint8Array(136);
  for (let i = 0; i < 5; i++) out[131 + i] = 0xf0;
  return out;
}

/** 列 0 個の超拡張データ形式（`queryLimited` を通すためだけの最小形） */
function emptyFormat(): Uint8Array {
  const out = new Uint8Array(16);
  new DataView(out.buffer).setUint32(4, 0);
  return out;
}

interface Frame {
  reqId: number;
  params: readonly { cp: number; value: Uint8Array }[];
}

const REQ_PREPARE_AND_DESCRIBE = 0x1803;
const CP_SQL_TEXT = 0x3807;

/** 送った SQL 文（UTF-16BE で載る）を読み戻す */
function sentSql(frame: Frame): string | undefined {
  const p = frame.params.find((x) => x.cp === CP_SQL_TEXT);
  if (!p) return undefined;
  const v = new DataView(p.value.buffer, p.value.byteOffset, p.value.byteLength);
  const len = v.getUint16(2);
  let s = "";
  for (let i = 0; i < len / 2; i++) s += String.fromCharCode(v.getUint16(4 + i * 2));
  return s;
}

/**
 * 偽の接続。送られた SQL を記録し、`fail` に一致する文だけ失敗させる。
 * `sql-execute.test.ts` の作り方に倣う。
 */
function fakeConn(opts: { failOn?: RegExp } = {}) {
  const statements: string[] = [];
  const request = vi.fn(async (frame: Frame) => {
    if (frame.reqId === REQ_PREPARE_AND_DESCRIBE) {
      const sql = sentSql(frame);
      if (sql !== undefined) statements.push(sql);
      if (sql !== undefined && opts.failOn?.test(sql)) {
        // prepare 段の失敗（SQLCODE < 0）
        const bad = sqlcaOk();
        new DataView(bad.buffer).setInt32(12, -443);
        return { params: [{ cp: CP_SQLCA, value: bad }], dbTemplate: { rcClass: 0, rcClassReturnCode: 0 } };
      }
    }
    return {
      params: [
        { cp: CP_SQLCA, value: sqlcaOk() },
        { cp: CP_SUPER_EXTENDED_FORMAT, value: emptyFormat() }
      ],
      dbTemplate: { rcClass: 0, rcClassReturnCode: 0 }
    };
  });
  let held = 0;
  const conn = {
    request,
    acquire: () => {
      held += 1;
      return () => {
        held -= 1;
      };
    }
  } as unknown as DbConnection;
  return { conn, statements, held: () => held };
}

const AT = "2026-08-02T00:00:00Z";

describe("QTEMP の表名", () => {
  it("システム名の上限 10 文字に収まり、英字で始まる", () => {
    for (const seed of [0, 1, 1785711757587, Number.MAX_SAFE_INTEGER]) {
      const name = monitorTableName(seed);
      expect(name).toMatch(/^VEP[0-9A-Z]{7}$/u);
      expect(name.length).toBe(10);
    }
  });

  it("種が違えば名前が違う（残骸と衝突させない）", () => {
    expect(monitorTableName(1)).not.toBe(monitorTableName(2));
  });
});

describe("採取手順の不変条件", () => {
  it("ENDDBMON（掃除）→ STRDBMON → 対象文 → ENDDBMON → 読み出し → DROP の順に流す", async () => {
    const { conn, statements } = fakeConn();
    await capturePlan(conn, "SELECT 1 FROM SYSIBM.SYSDUMMY1", { mode: "run", at: AT }).catch(() => undefined);

    const joined = statements.join("\n");
    expect(statements[0]).toContain("ENDDBMON");
    expect(statements[1]).toContain("STRDBMON OUTFILE(QTEMP/VEP");
    expect(statements[1]).toContain("JOB(*) TYPE(*DETAIL)");
    expect(joined).toContain("SELECT 1 FROM SYSIBM.SYSDUMMY1");
    expect(joined).toContain("DROP TABLE QTEMP.VEP");
    // ENDDBMON は掃除と停止で 2 回
    expect(statements.filter((s) => s.includes("ENDDBMON"))).toHaveLength(2);
  });

  it("**STRDBMON が失敗したら対象の文を実行しない**", async () => {
    const { conn, statements } = fakeConn({ failOn: /STRDBMON/u });
    await expect(
      capturePlan(conn, "DELETE FROM QTEMP.T", { mode: "run", at: AT })
    ).rejects.toThrow(As400Error);

    expect(statements.some((s) => s.includes("DELETE FROM QTEMP.T"))).toBe(false);
  });

  it("STRDBMON が失敗したら理由の分かるエラーになる", async () => {
    const { conn } = fakeConn({ failOn: /STRDBMON/u });
    await expect(capturePlan(conn, "SELECT 1", { mode: "run", at: AT })).rejects.toThrow(
      /実行計画を採取できません/u
    );
  });

  it("**対象の文が失敗しても ENDDBMON と DROP は通る**", async () => {
    const { conn, statements } = fakeConn({ failOn: /BROKEN/u });
    await expect(capturePlan(conn, "SELECT BROKEN FROM T", { mode: "run", at: AT })).rejects.toThrow();

    expect(statements.filter((s) => s.includes("ENDDBMON"))).toHaveLength(2);
    expect(statements.some((s) => s.includes("DROP TABLE QTEMP.VEP"))).toBe(true);
  });

  it("計画記録が 1 件も無ければ**空の計画を成功として返さない**", async () => {
    const { conn } = fakeConn();
    await expect(capturePlan(conn, "SELECT 1", { mode: "run", at: AT })).rejects.toThrow(
      /計画記録が採れませんでした/u
    );
  });

  it("接続の占有を残さない（すべて解放されている）", async () => {
    const { conn, held } = fakeConn();
    await capturePlan(conn, "SELECT 1", { mode: "run", at: AT }).catch(() => undefined);
    expect(held()).toBe(0);
  });

  it("no-rows モードは非クエリ文を拒む（黙って run に落とさない）", async () => {
    const { conn, statements } = fakeConn();
    await expect(
      capturePlan(conn, "DELETE FROM QTEMP.T", { mode: "no-rows", at: AT })
    ).rejects.toThrow(/SELECT 系の文でのみ/u);
    // **拒んだうえで DELETE を流していない**
    expect(statements.some((s) => s.startsWith("DELETE"))).toBe(false);
  });

  it("no-rows で拒んだあとも後始末は通る", async () => {
    const { conn, statements } = fakeConn();
    await capturePlan(conn, "UPDATE QTEMP.T SET A = 1", { mode: "no-rows", at: AT }).catch(() => undefined);
    expect(statements.filter((s) => s.includes("ENDDBMON"))).toHaveLength(2);
    expect(statements.some((s) => s.includes("DROP TABLE"))).toBe(true);
  });
});

const rec = (over: Partial<MonitorRecord> & { QQRID: number; QQUCNT: number }): MonitorRecord => ({
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
  ...over
});

describe("対象の文を選ぶ", () => {
  it("QQ1000 が一致する群を選ぶ（ジョブ全体の記録から対象文だけを取り出す）", () => {
    const picked = pickStatementRecords(
      [
        rec({ QQRID: 1000, QQUCNT: 1, QQ1000: "CALL QSYS2.QCMDEXC('STRDBMON …')" }),
        rec({ QQRID: 3000, QQUCNT: 2, QQ1000: "SELECT A FROM T" }),
        rec({ QQRID: 3001, QQUCNT: 2 })
      ],
      "SELECT A FROM T"
    );
    expect(picked).toHaveLength(2);
    expect(picked[0]?.QQUCNT).toBe(2);
  });

  it("空白の違いを無視する（改行を含む文でも一致する）", () => {
    const picked = pickStatementRecords(
      [rec({ QQRID: 3000, QQUCNT: 5, QQ1000: "SELECT A FROM T" })],
      "SELECT   A\n  FROM T"
    );
    expect(picked[0]?.QQUCNT).toBe(5);
  });

  it("大文字小文字を無視する", () => {
    const picked = pickStatementRecords(
      [rec({ QQRID: 3000, QQUCNT: 5, QQ1000: "select a from t" })],
      "SELECT A FROM T"
    );
    expect(picked[0]?.QQUCNT).toBe(5);
  });

  it("切り詰められた QQ1000 でも前方一致で拾う", () => {
    const long = `SELECT ${"A".repeat(60)} FROM T`;
    const picked = pickStatementRecords(
      [rec({ QQRID: 3000, QQUCNT: 7, QQ1000: long.slice(0, 40) })],
      long
    );
    expect(picked[0]?.QQUCNT).toBe(7);
  });

  it("一致が無ければ計画記録が最も多い群に落とす", () => {
    const picked = pickStatementRecords(
      [
        rec({ QQRID: 3000, QQUCNT: 1 }),
        rec({ QQRID: 3000, QQUCNT: 2 }),
        rec({ QQRID: 3001, QQUCNT: 2 }),
        rec({ QQRID: 3020, QQUCNT: 2 })
      ],
      "SELECT 何か"
    );
    expect(picked).toHaveLength(3);
    expect(picked[0]?.QQUCNT).toBe(2);
  });

  it("計画記録が 1 件も無ければ空を返す（空の計画を作らせない）", () => {
    const picked = pickStatementRecords([rec({ QQRID: 3018, QQUCNT: 1, QQQDTN: null })], "SELECT 1");
    expect(picked).toEqual([]);
  });

  it("記録が空なら空", () => {
    expect(pickStatementRecords([], "SELECT 1")).toEqual([]);
  });

  /**
   * 実機 7.3 の実測形。**同じ文のテキストが 2 つの群に現れる**——
   * `STRDBMON` 直後の `QQUCNT=0` は目印（`3018`）と文の要約（`1000`）だけを持ち、
   * 計画記録を 1 件も持たない。群は現れた順なので `QQUCNT=0` が先に当たる。
   *
   * 件数を見ずに「先に一致した群」を返していたため、**リテラルを含まない文は
   * ことごとく空の計画になっていた**（利用者の報告で判明）。リテラルを含む文が
   * 無事だったのは、ホストが値を `?` に置き換えて記録するのでテキストが一致せず、
   * 2 段目（件数で選ぶ）に落ちていたという**偶然**による。
   */
  it("文が一致しても**計画記録を持たない群は選ばない**（STRDBMON 直後の QQUCNT=0）", () => {
    const SQL = "SELECT * FROM TESTLIB.M_MENUTR T1 INNER JOIN TESTLIB.M_MENU T2 ON T2.MENUCD = T1.CMENUCD";
    const picked = pickStatementRecords(
      [
        // 受け皿の群。**文のテキストは持つが計画記録（QQQDTN）は無い**
        rec({ QQRID: 3018, QQUCNT: 0, QQQDTN: null }),
        rec({ QQRID: 1000, QQUCNT: 0, QQQDTN: null, QQ1000: SQL }),
        // 実行の群。こちらに計画が付く
        rec({ QQRID: 3000, QQUCNT: 3, QQQDTN: 1 }),
        rec({ QQRID: 3001, QQUCNT: 3, QQQDTN: 1 }),
        rec({ QQRID: 1000, QQUCNT: 3, QQQDTN: null, QQ1000: SQL }),
        rec({ QQRID: 1000, QQUCNT: 0, QQQDTN: null, QQ1000: "CALL QSYS2.QCMDEXC('ENDDBMON JOB(*)')" })
      ],
      SQL
    );
    expect(picked[0]?.QQUCNT).toBe(3);
    expect(buildQueryPlan(picked, { captured: "run", at: AT }).summary.nodeCount).toBe(2);
  });

  it("前方一致（切り詰め）でも計画記録を持たない群は選ばない", () => {
    const long = `SELECT ${"A".repeat(60)} FROM T`;
    const picked = pickStatementRecords(
      [
        rec({ QQRID: 1000, QQUCNT: 0, QQQDTN: null, QQ1000: long.slice(0, 40) }),
        rec({ QQRID: 3000, QQUCNT: 4, QQQDTN: 1, QQ1000: long.slice(0, 40) })
      ],
      long
    );
    expect(picked[0]?.QQUCNT).toBe(4);
  });
});

describe("ODP 再利用で計画が採れないとき", () => {
  /**
   * 実機で実測: **同じ接続で同じ文を 2 回完全オープンすると、3 回目以降は
   * 最適化記録が出なくなる**（1・2 回目は 12 ノード、3 回目以降は 0 ノード。文を変えれば復活）。
   * IBM i がオープン済みデータパス（ODP）を再利用して完全オープンを避けるため。
   *
   * このとき **`QQ1000` を持つ記録は引けてしまう**ので、件数だけ見ていると
   * 「空の計画」を成功として返してしまう。**ノード数で弾く**。
   */
  it("記録はあるがノードが 0 件なら**成功にしない**", () => {
    const plan = buildQueryPlan(
      // QQ1000 は引けるが QQQDTN を持たない＝計画ノードにならない記録だけ
      [
        { ...rec({ QQRID: 1000, QQUCNT: 1 }), QQQDTN: null, QQ1000: "SELECT A FROM T" },
        { ...rec({ QQRID: 3018, QQUCNT: 1 }), QQQDTN: null }
      ],
      { captured: "run", at: AT }
    );
    expect(plan.summary.nodeCount).toBe(0);
  });

  it("理由に「オープン済みデータパスの再利用」を書く（利用者が手を打てるように）", async () => {
    const { conn } = fakeConn();
    await expect(capturePlan(conn, "SELECT 1", { mode: "run", at: AT })).rejects.toThrow(
      /オープン済みデータパスを再利用/u
    );
  });
});
