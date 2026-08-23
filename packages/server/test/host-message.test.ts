import { describe, it, expect } from "vitest";
import { buildListSql, buildSendCommand, buildReplyCommand } from "../src/host-message.js";

/**
 * **利用者の入力が CL コマンド文字列に入る**——この作業で一番危ういところ。
 *
 * 待ち行列名に `X) DLTLIB LIB(PROD` のようなものが通ってしまうと、
 * 組み立てた `CLRMSGQ MSGQ(X) DLTLIB LIB(PROD)` が**別の命令として動く**。
 * 名前は書式で縛り、本文は引用符を二重化し、制御文字は拒否する。
 */
const src = { system: "srv:x" } as const;

describe("CL への差し込みを塞ぐ", () => {
  it("**名前に括弧・空白・引用符を通さない**", () => {
    for (const bad of ["X) DLTLIB LIB(PROD", "A B", "A'B", "A(B", "", "TOOLONGNAME1", "*ALL"]) {
      expect(() => buildSendCommand({ source: src, text: "hi", toQueue: bad }), bad).toThrowError();
    }
  });

  it("**利用者名も同じ検査を通る**", () => {
    expect(() => buildSendCommand({ source: src, text: "hi", toUser: "A) X(" })).toThrowError();
  });

  it("**本文の引用符は二重化する**（早じまいさせない）", () => {
    const cmd = buildSendCommand({ source: src, text: "it's ok", toUser: "USER" });
    expect(cmd).toContain("MSG('it''s ok')");
    // 閉じ引用符の数が合っている（早じまいしていない）
    expect((cmd.match(/'/gu) ?? []).length % 2).toBe(0);
  });

  it("**改行・制御文字は拒否**（コマンドが途中で切れる）", () => {
    for (const bad of ["a\nb", "a\rb", "a\x00b", "a\x1bb"]) {
      expect(() => buildSendCommand({ source: src, text: bad, toUser: "USER" })).toThrowError();
    }
  });

  it("**メッセージキーは 16 進 8 桁だけ**", () => {
    for (const bad of ["", "ZZZZZZZZ", "0000022", "00000220 ') X(", "0x000220"]) {
      expect(() =>
        buildReplyCommand({ source: src, queue: "TSTMSGQ", key: bad, reply: "YES" }), bad
      ).toThrowError();
    }
    expect(buildReplyCommand({ source: src, queue: "TSTMSGQ", key: "00000220", reply: "YES" })).toContain(
      "MSGKEY(X'00000220')"
    );
  });

  it("応答の本文も二重化される", () => {
    const cmd = buildReplyCommand({ source: src, queue: "Q", key: "0000000A", reply: "it's" });
    expect(cmd).toContain("RPY('it''s')");
  });
});

describe("組み立て", () => {
  it("ライブラリー省略は `*LIBL`", () => {
    expect(buildSendCommand({ source: src, text: "x", toQueue: "Q" })).toContain("TOMSGQ(*LIBL/Q)");
  });

  it("`*` 付きの特殊値は通す", () => {
    expect(buildSendCommand({ source: src, text: "x", toQueue: "Q", toLibrary: "*CURLIB" })).toContain(
      "TOMSGQ(*CURLIB/Q)"
    );
  });

  it("**照会には応答先が要る**（省略時は宛先を使う）", () => {
    const cmd = buildSendCommand({ source: src, text: "x", toQueue: "Q", toLibrary: "L", inquiry: true });
    expect(cmd).toContain("MSGTYPE(*INQ)");
    expect(cmd).toContain("RPYMSGQ(L/Q)");
  });

  it("**宛先が無ければ断る**", () => {
    expect(() => buildSendCommand({ source: src, text: "x" })).toThrowError();
  });

  it("小文字は大文字にそろえる（IBM i の名前は大文字）", () => {
    expect(buildSendCommand({ source: src, text: "x", toUser: "user" })).toContain("TOUSR(USER)");
  });
});

describe("一覧の SQL", () => {
  const base = { queue: "QSYSOPR", library: "QSYS", ccsid: 5026, max: 50 };

  it("**`SELECT *` を使わない**（MESSAGE_KEY が BINARY で DB 層が断る）", () => {
    const sql = buildListSql(base);
    expect(sql).not.toContain("SELECT *");
    expect(sql).toContain("HEX(MESSAGE_KEY)");
  });

  it("**本文は CCSID を指定して CAST**（VARGRAPHIC のままだと読めない）", () => {
    expect(buildListSql(base)).toContain("CCSID 5026");
  });

  it("**照会だけに絞れる**（応答すべきものが分かる）", () => {
    expect(buildListSql({ ...base, onlyInquiry: true })).toContain("MESSAGE_TYPE = 'INQUIRY'");
    expect(buildListSql(base)).not.toContain("MESSAGE_TYPE =");
  });

  it("`*LIBL` ならライブラリーで絞らない", () => {
    expect(buildListSql({ ...base, library: "*LIBL" })).not.toContain("MESSAGE_QUEUE_LIBRARY");
  });

  it("新しい順・件数の上限つき", () => {
    expect(buildListSql(base)).toContain("ORDER BY MESSAGE_TIMESTAMP DESC");
    expect(buildListSql(base)).toContain("FETCH FIRST 50 ROWS ONLY");
  });
});
