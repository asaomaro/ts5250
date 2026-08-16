import { describe, it, expect } from "vitest";
import { Tn3270Session } from "../src/session/session.js";
import type { Transport } from "../src/transport/types.js";
import { encodeAddress } from "../src/protocol/address.js";
import { CMD3270, ORDER, WCC, XA } from "../src/protocol/constants.js";
import { IAC, CMD, OPT, TT_SEND } from "../src/telnet/constants.js";

class MockTransport implements Transport {
  sent: number[][] = [];
  private dataFn: ((d: Uint8Array) => void) | undefined;
  private closeFn: ((r: string) => void) | undefined;
  send(data: Uint8Array): void {
    this.sent.push([...data]);
  }
  close(): void {
    this.closeFn?.("closed");
  }
  onData(fn: (d: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(fn: (r: string) => void): void {
    this.closeFn = fn;
  }
  onError(): void {}
  recv(...b: number[]): void {
    this.dataFn?.(Uint8Array.from(b));
  }
  /** アプリのレコードを 1 つ流す（IAC EOR 付き） */
  recvRecord(bytes: number[]): void {
    this.recv(...bytes, IAC, CMD.EOR);
  }
  get lastRecord(): string {
    const flat = this.sent[this.sent.length - 1] ?? [];
    return flat.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
}

const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];

/** 交渉を済ませたセッションを作る */
function connected(): { s: Tn3270Session; t: MockTransport } {
  const t = new MockTransport();
  const s = new Tn3270Session({ host: "x", model: 2 });
  s.attach(t);
  t.recv(IAC, CMD.DO, OPT.TERMINAL_TYPE);
  t.recv(IAC, CMD.SB, OPT.TERMINAL_TYPE, TT_SEND, IAC, CMD.SE);
  t.recv(IAC, CMD.DO, OPT.END_OF_RECORD, IAC, CMD.WILL, OPT.END_OF_RECORD);
  t.recv(IAC, CMD.DO, OPT.BINARY, IAC, CMD.WILL, OPT.BINARY);
  return { s, t };
}

/** 非保護欄（属性桁 0）と保護欄（属性桁 20）を持つ画面を流す */
function sendScreen(t: MockTransport): void {
  t.recvRecord([
    CMD3270.ERASE_WRITE, WCC.RESTORE,
    ...sba(0), ORDER.SF, 0x00,
    ...sba(20), ORDER.SF, 0x20,
    ...sba(1), ORDER.IC
  ]);
}

describe("状態機械", () => {
  it("交渉が終わると ready になる", () => {
    const { s } = connected();
    expect(s.status).toBe("ready");
  });

  it("AID を送るとロックされ、WCC の restore で戻る", () => {
    const { s, t } = connected();
    sendScreen(t);
    expect(s.status).toBe("ready");
    s.send("enter");
    expect(s.status).toBe("locked");
    t.recvRecord([CMD3270.WRITE, WCC.RESTORE]);
    expect(s.status).toBe("ready");
  });

  it("ロック中の入力は KEYBOARD_LOCKED で拒否する", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.send("enter");
    expect(() => s.type("A")).toThrow(/keyboard is locked/);
    expect(() => s.send("pf1")).toThrow(/keyboard is locked/);
  });

  it("閉じたセッションは使えない", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.close();
    expect(() => s.type("A")).toThrow(/session is closed/);
  });
});

describe("入力", () => {
  it("非保護欄に書けて MDT が立つ", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.setCursor(1, 2);
    s.type("AB");
    const mod = s.modifiedFields();
    expect(mod.length).toBe(1);
    expect(mod[0]!.value.startsWith("AB")).toBe(true);
  });

  it("保護欄への入力は FIELD_PROTECTED で拒否する", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.setCursor(1, 22); // 属性桁 20 の次＝保護欄の中身
    expect(() => s.type("A")).toThrow(/protected/);
  });

  it("属性桁そのものへの入力も拒否する", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.setCursor(1, 1); // 属性桁
    expect(() => s.type("A")).toThrow(/field attribute/);
  });

  it("画面外へのカーソル移動は拒否する", () => {
    const { s, t } = connected();
    sendScreen(t);
    expect(() => s.setCursor(99, 1)).toThrow(/out of screen/);
  });
});

describe("送信バイト", () => {
  it("入力後の Enter に変更欄の内容が乗る", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.setCursor(1, 2);
    s.type("AB");
    s.send("enter");
    // AID(7d) + カーソル + SBA + 欄の先頭 + "AB"(c1c2) + IAC EOR(ffef)
    expect(t.lastRecord.startsWith("7d")).toBe(true);
    expect(t.lastRecord).toMatch(/11.{4}c1c2ffef$/);
  });

  it("PA1 は AID 1 バイトだけ（実測）", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.send("pa1");
    expect(t.lastRecord).toBe("6cffef");
  });

  it("Clear は画面を消す", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.setCursor(1, 2);
    s.type("AB");
    s.send("clear");
    expect(t.lastRecord).toBe("6dffef");
    expect(s.snapshot().unformatted).toBe(true); // 消えたので属性桁も無い
  });
});

describe("ホスト起動の読み取りに応答する", () => {
  it("Read Modified コマンドに AID 0x60 で返す", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.setCursor(1, 2);
    s.type("AB");
    const before = t.sent.length;
    t.recvRecord([CMD3270.READ_MODIFIED]);
    expect(t.sent.length).toBeGreaterThan(before);
    expect(t.lastRecord.startsWith("60")).toBe(true);
    expect(t.lastRecord).toMatch(/11.{4}c1c2ffef$/);
  });

  /**
   * **端末は直前の AID を覚えている**（s3270 実測）。
   * ホスト起因の読みは 0x60 固定ではなく、覚えている AID を先頭に置く。
   */
  it("**PA1 の後の Read Modified は AID 1 バイトだけ**（短形式を繰り返す）", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.setCursor(1, 2);
    s.type("AB");
    s.send("pa1");
    expect(t.lastRecord).toBe("6cffef"); // 押下そのものも短形式
    t.recvRecord([CMD3270.READ_MODIFIED]);
    expect(t.lastRecord).toBe("6cffef"); // 読みにも短形式で答える
  });

  it("**Read Modified All は短形式を無視して欄まで返す**", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.setCursor(1, 2);
    s.type("AB");
    s.send("pa1");
    t.recvRecord([CMD3270.READ_MODIFIED_ALL]);
    expect(t.lastRecord.startsWith("6c")).toBe(true); // AID は覚えたまま
    expect(t.lastRecord).toMatch(/11.{4}c1c2ffef$/); // 欄が付く
  });

  it("**Read Buffer も覚えている AID を返す**（0x60 固定ではない）", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.send("pa1");
    t.recvRecord([CMD3270.READ_BUFFER]);
    expect(t.lastRecord.startsWith("6c")).toBe(true);
  });

  it("**キーボードが復旧すると AID を忘れる**", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.send("pa1");
    t.recvRecord([CMD3270.WRITE, WCC.RESTORE]);
    t.recvRecord([CMD3270.READ_MODIFIED]);
    expect(t.lastRecord.startsWith("60")).toBe(true);
  });

  it("**復旧ビットの無い書き込みでは忘れない**", () => {
    const { s, t } = connected();
    sendScreen(t);
    s.send("pa1");
    t.recvRecord([CMD3270.WRITE, 0x00]);
    t.recvRecord([CMD3270.READ_MODIFIED]);
    expect(t.lastRecord).toBe("6cffef");
  });
});

describe("Erase All Unprotected（EAU）", () => {
  /** 保護＋MDT / 非保護＋MDT / 非保護 の 3 欄 */
  function mdtScreen(t: MockTransport): void {
    t.recvRecord([
      CMD3270.ERASE_WRITE, WCC.RESTORE,
      ...sba(0), ORDER.SF, 0x61, 0xd7,       // 保護＋MDT。"P"
      ...sba(10), ORDER.SF, 0x01, 0xc1, 0xc1, // 非保護＋MDT。"AA"
      ...sba(30), ORDER.SF, 0x60
    ]);
  }

  it("**非保護欄だけ消す**——保護欄の文字は残る", () => {
    const { s, t } = connected();
    mdtScreen(t);
    t.recvRecord([CMD3270.ERASE_ALL_UNPROTECTED]);
    const rows = s.snapshot().cells.map((r) => r.map((c) => c.char).join(""));
    expect(rows[0]!.slice(1, 2)).toBe("P");     // 保護欄は残る
    expect(rows[0]!.slice(11, 13).trim()).toBe(""); // 非保護欄は消える
  });

  it("**MDT を落とすのは非保護欄だけ**（保護欄の MDT は残る。実測）", () => {
    const { s, t } = connected();
    mdtScreen(t);
    t.recvRecord([CMD3270.ERASE_ALL_UNPROTECTED]);
    const fields = s.snapshot().fields;
    const prot = fields.find((f) => f.attrRow === 1 && f.attrCol === 1)!;
    const unprot = fields.find((f) => f.attrRow === 1 && f.attrCol === 11)!;
    expect(prot.modified).toBe(true);
    expect(unprot.modified).toBe(false);
  });

  it("**カーソルは最初の非保護桁へ**（実測）", () => {
    const { s, t } = connected();
    mdtScreen(t);
    s.setCursor(5, 5);
    t.recvRecord([CMD3270.ERASE_ALL_UNPROTECTED]);
    expect(s.snapshot().cursor).toEqual({ row: 1, col: 12 }); // アドレス 11
  });

  it("**応答は返さない**——WCC もオーダーも無い命令", () => {
    const { s, t } = connected();
    mdtScreen(t);
    const before = t.sent.length;
    t.recvRecord([CMD3270.ERASE_ALL_UNPROTECTED]);
    expect(t.sent.length).toBe(before);
    expect(s.status).toBe("ready"); // キーボードは復旧する
  });

  it("**覚えている AID も忘れる**（キーボードが復旧するため）", () => {
    const { s, t } = connected();
    mdtScreen(t);
    s.send("pa1");
    t.recvRecord([CMD3270.ERASE_ALL_UNPROTECTED]);
    t.recvRecord([CMD3270.READ_MODIFIED]);
    expect(t.lastRecord.startsWith("60")).toBe(true);
  });
});

describe("画面イベント", () => {
  it("受信のたびに snapshot が飛ぶ", () => {
    const { s, t } = connected();
    const seen: number[] = [];
    s.on("screen", (snap) => seen.push(snap.fields.length));
    sendScreen(t);
    expect(seen.length).toBe(1);
    expect(seen[0]).toBe(2);
  });
});

describe("応答モードの寿命", () => {
  /** `Set Reply Mode` の構造化フィールド */
  const srm = (mode: number, types: number[] = []): number[] => [
    CMD3270.WRITE_STRUCTURED_FIELD, 0x00, 5 + types.length, 0x09, 0x00, mode, ...types
  ];

  function coloredScreen(t: MockTransport): void {
    t.recvRecord([
      CMD3270.ERASE_WRITE, WCC.RESTORE,
      ...sba(0), ORDER.SFE, 0x02, XA.BASIC, 0x60, XA.FOREGROUND, 0xf2,
      ...sba(20), ORDER.SF, 0x00
    ]);
  }

  it("**指定するまでは欄モード**", () => {
    const { s, t } = connected();
    coloredScreen(t);
    t.recvRecord([CMD3270.READ_BUFFER]);
    expect(t.lastRecord).toContain("1d60");
    expect(s.status).toBe("ready");
  });

  it("**拡張欄モードにすると SFE で返す**", () => {
    const { t } = connected();
    coloredScreen(t);
    t.recvRecord(srm(1));
    t.recvRecord([CMD3270.READ_BUFFER]);
    expect(t.lastRecord).toContain("2902c06042f2");
  });

  it("**平の Write では戻らない**", () => {
    const { t } = connected();
    coloredScreen(t);
    t.recvRecord(srm(1));
    t.recvRecord([CMD3270.WRITE, WCC.RESTORE]);
    t.recvRecord([CMD3270.READ_BUFFER]);
    expect(t.lastRecord).toContain("2902c06042f2");
  });

  it("**消して書くだけでも戻らない**——WCC のリセットビットが要る（実測）", () => {
    const { t } = connected();
    coloredScreen(t);
    t.recvRecord(srm(1));
    coloredScreen(t); // Erase/Write だが WCC は RESTORE だけ
    t.recvRecord([CMD3270.READ_BUFFER]);
    expect(t.lastRecord).toContain("2902c06042f2");
  });

  it("**消して書く＋リセットビットで戻る**", () => {
    const { t } = connected();
    coloredScreen(t);
    t.recvRecord(srm(1));
    t.recvRecord([
      CMD3270.ERASE_WRITE, WCC.RESET | WCC.RESTORE,
      ...sba(0), ORDER.SFE, 0x02, XA.BASIC, 0x60, XA.FOREGROUND, 0xf2
    ]);
    t.recvRecord([CMD3270.READ_BUFFER]);
    expect(t.lastRecord).toContain("1d60");
    expect(t.lastRecord).not.toContain("2902");
  });
});

describe("カーソル移動キー", () => {
  /** 0 保護 ／ 10 非保護(11-15) ／ 16 自動スキップ(保護＋数字) ／ 20 非保護(21-25) ／ 26 保護 */
  function movScreen(t: MockTransport): void {
    t.recvRecord([
      CMD3270.ERASE_WRITE, WCC.RESTORE,
      ...sba(0), ORDER.SF, 0x60,
      ...sba(10), ORDER.SF, 0x00,
      ...sba(16), ORDER.SF, 0x30,
      ...sba(20), ORDER.SF, 0x00,
      ...sba(26), ORDER.SF, 0x60,
      ...sba(11), ORDER.IC
    ]);
  }
  const addr = (s: Tn3270Session): number => {
    const c = s.snapshot().cursor;
    return (c.row - 1) * 80 + c.col - 1;
  };
  const go = (s: Tn3270Session, a: number): void => s.setCursor(Math.floor(a / 80) + 1, (a % 80) + 1);

  it("**Home は最初の非保護桁へ**", () => {
    const { s, t } = connected();
    movScreen(t);
    go(s, 5);
    s.home();
    expect(addr(s)).toBe(11);
  });

  it("**Tab は次の非保護欄の先頭へ**（保護欄は飛ばす）", () => {
    const { s, t } = connected();
    movScreen(t);
    go(s, 13); // 欄の途中からでも次の欄へ
    s.tab();
    expect(addr(s)).toBe(21);
    s.tab(); // 最後まで行ったら回り込む
    expect(addr(s)).toBe(11);
  });

  it("**BackTab はまず欄の先頭へ**、先頭にいるなら手前の欄へ", () => {
    const { s, t } = connected();
    movScreen(t);
    go(s, 23);
    s.backTab();
    expect(addr(s)).toBe(21);
    s.backTab();
    expect(addr(s)).toBe(11);
  });

  it("**左右は欄をまたぐ**——属性桁の上にも乗る（実測）", () => {
    const { s, t } = connected();
    movScreen(t);
    go(s, 21);
    s.left();
    expect(addr(s)).toBe(20); // 属性桁
    s.right();
    s.right();
    expect(addr(s)).toBe(22);
  });

  it("**上下は真上・真下へ**", () => {
    const { s, t } = connected();
    movScreen(t);
    go(s, 21);
    s.down();
    expect(addr(s)).toBe(101);
    s.up();
    expect(addr(s)).toBe(21);
  });

  it("**改行は次の行頭、打てなければその先の非保護欄へ**", () => {
    const { s, t } = connected();
    movScreen(t);
    go(s, 21);
    s.newline(); // 80 は保護欄の中なので回り込んで 11
    expect(addr(s)).toBe(11);
  });

  it("**自動スキップ欄は埋めた勢いで飛び越える**", () => {
    const { s, t } = connected();
    movScreen(t);
    go(s, 11);
    s.type("ABCDE"); // 欄(11-15)を埋める。16 は保護＋数字
    expect(addr(s)).toBe(21); // 17 ではなく次の非保護欄まで
  });

  it("**自動スキップでなければ属性桁の次で止まる**", () => {
    const { s, t } = connected();
    t.recvRecord([
      CMD3270.ERASE_WRITE, WCC.RESTORE,
      ...sba(10), ORDER.SF, 0x00,
      ...sba(16), ORDER.SF, 0x60, // 保護だが数字ではない
      ...sba(11), ORDER.IC
    ]);
    go(s, 11);
    s.type("ABCDE");
    expect(addr(s)).toBe(17);
  });
});
