import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import type { AidKey } from "../src/session/aid-keys.js";
import type { Transport } from "../src/transport/types.js";
import { ReplayTransport } from "../src/trace/replay.js";
import { bytesToHex, type TraceEntry } from "../src/trace/trace.js";
import { buildRecord } from "../src/protocol/gds.js";
import { ByteWriter } from "../src/protocol/bytes.js";
import { ESC, COMMAND, ORDER, OPCODE, FFW } from "../src/protocol/constants.js";
import { IAC, CMD } from "../src/telnet/constants.js";

/** telnet フレーミング（IAC エスケープ＋ IAC EOR）。`rx()`/`ReplayTransport` と同じ形。 */
function frame(record: Uint8Array): Uint8Array {
  const framed: number[] = [];
  for (const b of record) {
    framed.push(b);
    if (b === IAC) framed.push(IAC);
  }
  framed.push(IAC, CMD.EOR);
  return Uint8Array.from(framed);
}

/**
 * `ReplayTransport` は `send()` が呼ばれた瞬間に**同じ同期区間で**次の rx を配送してしまう
 * ため（`advance()` が `dataFn` を直接呼ぶ）、送信直後の一瞬だけ存在する内部状態
 * （`sendAid` 呼び出しの同期部分が終わった直後、応答がまだ届いていない状態）を
 * テストで観測できない。この Transport は `send()` を受けても**何も返さず**、
 * `deliver()` を明示的に呼ぶまで応答を止めておく。
 */
class DeferredTransport implements Transport {
  private dataFn: ((data: Uint8Array) => void) | undefined;
  readonly sent: Uint8Array[] = [];
  constructor(private readonly initial: Uint8Array) {}
  start(): void {
    this.dataFn?.(this.initial);
  }
  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {}
  onData(fn: (data: Uint8Array) => void): void {
    this.dataFn = fn;
  }
  onClose(_fn: (reason: string) => void): void {}
  onError(_fn: (err: Error) => void): void {}
  /** 保留していた応答を今届ける */
  deliver(data: Uint8Array): void {
    this.dataFn?.(data);
  }
}

/**
 * SEU の PageUp/PageDown で境界ページに到達したときのカーソル位置保持
 * （`.aidev/works/20260914-seu-page-cursor-hold`）。
 *
 * 実機トレース（`research.md` F1〜F6）で、境界ページでもホストは IC/MC で
 * **明示的に**カーソル位置を指定してくることを確認済み（IC/MC の欠落は無い）。
 * したがって、ここで検証するのは「ホストが明示的に指定した位置より、PageUp/PageDown
 * 送信直前の位置を優先する」という新しい分岐（`session.ts` の Rule1・Rule2）であり、
 * 既存の `cursor-default.test.ts`（IC 欠落時のフォールバック）とは別の観点になる。
 */
function rx(record: Uint8Array): TraceEntry {
  const framed: number[] = [];
  for (const b of record) {
    framed.push(b);
    if (b === IAC) framed.push(IAC);
  }
  framed.push(IAC, CMD.EOR);
  return { ts: "t", dir: "rx", hex: bytesToHex(Uint8Array.from(framed)) };
}

const FIELD_A = { row: 5, col: 10, len: 6 }; // 入力欄 → (5,11)〜(5,16)
const FIELD_B = { row: 8, col: 10, len: 6 }; // 入力欄 → (8,11)〜(8,16)
const FIELD_D = { row: 9, col: 10, len: 6 }; // 入力欄 → (9,11)〜(9,16)

/** 画面1枚目: FIELD_A のみ。IC で (5,11) を指す */
function screen1(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(FIELD_A.row).u8(FIELD_A.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_A.len);
  w.u8(ORDER.IC).u8(FIELD_A.row).u8(FIELD_A.col + 1);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/**
 * 画面2枚目・Rule2 用（境界=画面内容が完全一致）: 1枚目と**同一のレイアウト**
 * （FIELD_A・FIELD_B とも同じ位置に同じ属性で SF）を送り直すが、IC は FIELD_B を指す。
 * セル内容（文字・属性）は1枚目と変わらないので `cellsSignature()` は一致するはず。
 */
function screenRule2(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(FIELD_A.row).u8(FIELD_A.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_A.len);
  w.u8(ORDER.SBA).u8(FIELD_B.row).u8(FIELD_B.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_B.len);
  w.u8(ORDER.IC).u8(FIELD_B.row).u8(FIELD_B.col + 1); // FIELD_A ではなく FIELD_B を指す
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/** 画面1枚目と同じレイアウト＋FIELD_B（Rule2 の比較対象と同じ画面にするための下敷き） */
function screen1WithFieldB(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(FIELD_A.row).u8(FIELD_A.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_A.len);
  w.u8(ORDER.SBA).u8(FIELD_B.row).u8(FIELD_B.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_B.len);
  w.u8(ORDER.IC).u8(FIELD_A.row).u8(FIELD_A.col + 1);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/**
 * 画面2枚目・Rule1 用（境界の1つ手前=着地先が入力不可）: レイアウトを変え、FIELD_A は消えて
 * FIELD_B だけが残る（≒本文行の入力欄が画面から消えた）。IC はどの欄にも属さない (6,20) を指す。
 * FIELD_B が入力可能なので「画面に入力可能な欄が無い」という縮退（`cursorIsUnenterable`
 * が常に false を返すケース）にはならない。
 */
function screenRule1(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(FIELD_B.row).u8(FIELD_B.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_B.len);
  w.u8(ORDER.IC).u8(6).u8(20); // どの欄にも属さない桁
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/**
 * 画面（AC6 回帰用）: FIELD_A を**保護**にし、IC はその中を指す（＝送信前から
 * 既にカーソルが保護欄にいる状態）。FIELD_B は入力可能なまま残す。
 * PageDown の応答としてこれと**同一のバイト列**を送り返すことで、
 * 「画面完全一致（Rule2 相当）かつカーソルも動かない」という、新分岐と
 * 既存の保護欄退避分岐（`PR#387`）の両方の発火条件を同時に満たす状態を作る。
 */
function screenProtectedCursor(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(FIELD_A.row).u8(FIELD_A.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE | FFW.BYPASS).u8(0x20).u16(FIELD_A.len); // 保護欄
  w.u8(ORDER.SBA).u8(FIELD_B.row).u8(FIELD_B.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_B.len); // 入力可能な欄が他にある
  w.u8(ORDER.IC).u8(FIELD_A.row).u8(FIELD_A.col + 1); // 保護欄の中を指す
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/**
 * 画面2枚目・非境界用（AC3、回帰確認）: レイアウトを変え、FIELD_A は消えて
 * FIELD_D が現れる（≒普通にページが進んだ）。IC は FIELD_D（入力可能）を指す。
 */
function screenNonBoundary(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(FIELD_D.row).u8(FIELD_D.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_D.len);
  w.u8(ORDER.IC).u8(FIELD_D.row).u8(FIELD_D.col + 1);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/**
 * 1 画面目を出し、PageUp/PageDown を送って 2 画面目を受けたあとのカーソルを返す。
 * `tx` の印を挟むのは、`ReplayTransport` が**こちらが送るまで次の rx を流さない**ため。
 */
async function play(
  first: Uint8Array,
  second: Uint8Array,
  key: AidKey = "PageDown"
): Promise<{ row: number; col: number }> {
  const transport = new ReplayTransport([
    rx(first),
    { ts: "t", dir: "tx", masked: true, len: 0 },
    rx(second)
  ]);
  const session = await Session5250.connect({ transport, id: "t" });
  await session.sendAid(key, { timeoutMs: 2000 });
  return session.snapshot().cursor;
}

/**
 * `play()` と同じだが、PageUp/PageDown を送る際に `cursor` オプション（web-ui がマウス
 * クリックの位置を伝えるのに使う経路。design.md「実装時の注意」・research.md F7）を
 * 明示的に指定する。**サーバー内部の `buf.cursorAddr` は 1 画面目の IC が置いた位置のまま
 * 更新されない**——`opts.cursor` は送信レコードの値を一時的に上書きするだけで
 * `buf.cursorAddr` 自体は変えない、というのが `Session5250.sendAid` の元々の契約
 * （`research.md` F7）。この関数は「利用者がクリックで別の桁へカーソルを移してから
 * PageUp/PageDown を押した」という実際の利用パターンを再現する。
 */
async function playWithCursorOverride(
  first: Uint8Array,
  second: Uint8Array,
  overrideCursor: { row: number; col: number },
  key: AidKey = "PageDown"
): Promise<{ row: number; col: number }> {
  const transport = new ReplayTransport([
    rx(first),
    { ts: "t", dir: "tx", masked: true, len: 0 },
    rx(second)
  ]);
  const session = await Session5250.connect({ transport, id: "t" });
  await session.sendAid(key, { timeoutMs: 2000, cursor: overrideCursor });
  return session.snapshot().cursor;
}

describe("PageUp/PageDown で境界ページに到達したときカーソル位置を保持する", () => {
  it("AC1/AC8 Rule2 (PageDown): 画面内容が送信前後で完全一致すれば、ホストの新しい IC より送信前の位置を保つ", async () => {
    // screen1WithFieldB → screenRule2 はどちらも FIELD_A・FIELD_B の内容が同一
    // （cellsSignature 一致）。ホストは IC で FIELD_B(8,11) を指すが、
    // 送信前のカーソル位置 FIELD_A(5,11) が維持されるはず。
    expect(await play(screen1WithFieldB(), screenRule2())).toEqual({
      row: FIELD_A.row,
      col: FIELD_A.col + 1
    });
  });

  it("AC1 Rule1 (PageDown): カーソルが動いて着地先が入力不可なら、送信前の位置を保つ", async () => {
    // screenRule1 は画面内容が変わり（FIELD_A が消える）、IC はどの欄にも属さない
    // 桁を指す。FIELD_A(5,11) が維持されるはず。
    expect(await play(screen1(), screenRule1())).toEqual({
      row: FIELD_A.row,
      col: FIELD_A.col + 1
    });
  });

  it("AC2 Rule1: PageUp でも Rule1（着地先が入力不可）が対称に効く", async () => {
    expect(await play(screen1(), screenRule1(), "PageUp")).toEqual({
      row: FIELD_A.row,
      col: FIELD_A.col + 1
    });
  });

  it("AC2 Rule2: PageUp でも Rule2（画面無変化）が対称に効く", async () => {
    expect(await play(screen1WithFieldB(), screenRule2(), "PageUp")).toEqual({
      row: FIELD_A.row,
      col: FIELD_A.col + 1
    });
  });

  it("AC3: 途中ページ（非境界）遷移では、ホストの IC をそのまま適用する（回帰なし）", async () => {
    // 画面は変わり、IC は入力可能な新しい欄 FIELD_D を指す。
    // Rule1（着地先が入力不可）・Rule2（画面無変化）のいずれにも当たらないので、
    // 新しい分岐は発火せず、ホストの指定どおり FIELD_D へ移る。
    expect(await play(screen1(), screenNonBoundary())).toEqual({
      row: FIELD_D.row,
      col: FIELD_D.col + 1
    });
  });

  it("PageUp/PageDown 以外の AID キーでは新しい分岐は働かない（従来通り IC に従う）", async () => {
    // screenRule1 と同じ画面変化・IC だが、Enter で送るので isPageKey が false になり、
    // 新しい分岐は発火しない。既存の2分岐も対象外: 1つ目は `!cursorSet` のときだけ
    // （ここは cursorSet=true）、2つ目（PR#387）は「動いていない」ときだけ
    // （ここはカーソルが (5,11)→(6,20) へ動いている）。結果としてカーソルは
    // ホストの IC が指す (6,20) のまま（既存の正しい既定動作）。
    expect(await play(screen1(), screenRule1(), "Enter")).toEqual({ row: 6, col: 20 });
  });

  it("AC6 回帰: 送信前から既に保護欄にいたら、新分岐ではなく既存の保護欄退避に譲る", async () => {
    // 送信前カーソルは保護欄の中（cursorBeforeWasEnterable = false）。
    // PageDown の応答は送信前と完全に同一の画面（Rule2 の「画面無変化」も、
    // 「動いていない」という PR#387 の条件も同時に満たす）。
    // cursorBeforeWasEnterable が無ければ新分岐が先に評価され、保護欄のまま
    // （FIELD_A(5,11)）残ってしまう——PR#387 の退避（FIELD_B(8,11) へ寄せる）が
    // 正しく働くことを確認する。
    expect(await play(screenProtectedCursor(), screenProtectedCursor())).toEqual({
      row: FIELD_B.row,
      col: FIELD_B.col + 1
    });
  });

  it("実機で報告された回帰: クリックで別の欄へカーソルを移してから PageDown すると、" +
     "移した先（web-ui の cursor オプション）ではなく古い buf.cursorAddr へ戻ってしまう", async () => {
    // 1画面目の IC は FIELD_A(5,11) を指す（buf.cursorAddr はこの時点で FIELD_A）。
    // 利用者はここでマウスクリックし、FIELD_B(8,11) へカーソルを移す——web-ui はこれを
    // ローカルの cursorOverride としてのみ保持し、`buf.cursorAddr` はまだ FIELD_A のまま
    // （research.md F7: opts.cursor は送信レコードの値を一時的に上書きするだけ）。
    // その状態で PageDown を送る（screenRule2 で境界＝画面完全一致の応答が返る）。
    //
    // 修正前は `cursorBefore = this.buf.cursorAddr` が古い FIELD_A を指しているため、
    // Rule2 が「送信前の位置」として FIELD_A を復元してしまい、利用者が実際にクリックで
    // 移した FIELD_B は失われる（＝無関係な位置へカーソルが飛んで見える）。
    // 正しくは、この AID で実際にホストへ報告した位置（FIELD_B）を保つべき。
    expect(
      await playWithCursorOverride(
        screen1WithFieldB(),
        screenRule2(),
        { row: FIELD_B.row, col: FIELD_B.col + 1 }
      )
    ).toEqual({ row: FIELD_B.row, col: FIELD_B.col + 1 });
  });

  it("実機で報告された回帰（PageUp）: 同じ現象が PageUp でも起きないことを確認する", async () => {
    // 利用者の実機報告は PageUp（`decisions.md` D5）。web-ui はキー種別を問わず
    // `cursor.value` をそのつど渡すため（`EmulatorPane.vue` の AID 送信経路）、
    // 修正自体は PageUp/PageDown どちらの方向にも対称に効くはずだが、それを
    // 直接示す自動テストが無かった（review で指摘）。
    expect(
      await playWithCursorOverride(
        screen1WithFieldB(),
        screenRule2(),
        { row: FIELD_B.row, col: FIELD_B.col + 1 },
        "PageUp"
      )
    ).toEqual({ row: FIELD_B.row, col: FIELD_B.col + 1 });
  });

  it("不正な cursor オプション（非整数）は sendAid 呼び出し直後の内部状態を壊さない", async () => {
    // WS の `key`/`gui-submit` メッセージの `cursor` はランタイム検証されていないため、
    // 不正な値がそのまま `sendAid` に届きうる（タスク点検で指摘）。`addrOf` の範囲チェックは
    // `row`/`col` が非数値（例: NaN）だと通過してしまい例外を投げないため、検証を自前で
    // 行う必要がある。
    //
    // **この破損は応答を待つ前——`sendAid` 呼び出しの同期部分が終わった直後、
    // 応答がまだ届いていない一瞬——にしか観測できない**。応答が届けば、ホストの IC/MC
    // （または `!cursorSet` 時の `cursorToFirstInputField()`）が必ず有効なアドレスで
    // 上書きするため、その後に `snapshot()` を見るテストでは破損を検出できない。
    // **`ReplayTransport` はこの一瞬を作れない**——`send()` が同じ同期区間で次の rx を
    // 配送してしまうため（`advance()` が `dataFn` を直接呼ぶ）、`sendAid` が返った時点で
    // 応答処理まで完了してしまっている（実際、この検証にも関わらず `ReplayTransport` で
    // 書いた版はガード無しの旧実装でも見かけ上 green になった）。そのため、応答を
    // 明示的に呼ぶまで止めておける `DeferredTransport` を使う。
    const initial = frame(screen1());
    const transport = new DeferredTransport(initial);
    const session = await Session5250.connect({ transport, id: "t" });
    // @ts-expect-error 不正な値（非整数）を意図的に渡す
    const pending = session.sendAid("PageDown", { timeoutMs: 2000, cursor: { row: NaN, col: 5 } });
    // ここが「送信した・応答はまだ」の一瞬（web-ui がクリック直後に楽観的更新として
    // `session.snapshot()` を読む経路を想定）。
    const immediate = session.snapshot().cursor;
    expect(Number.isFinite(immediate.row)).toBe(true);
    expect(Number.isFinite(immediate.col)).toBe(true);
    // 不正な値は無視されるので、送信前の位置（screen1 の IC が置いた FIELD_A）のまま
    expect(immediate).toEqual({ row: FIELD_A.row, col: FIELD_A.col + 1 });
    // 保留していた応答を届けて後始末する
    transport.deliver(frame(screen1()));
    await pending;
  });
});
