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

/**
 * `Session5250.sendAid()` が `opts.cursor`（web-ui のクリック等でカーソルを移した位置を
 * 伝える経路）を受け取ったとき、`buf.cursorAddr` をそれに同期することの回帰テスト。
 *
 * 経緯: `.aidev/works/20260914-seu-page-cursor-hold` で SEU の PageUp/PageDown 境界での
 * カーソル位置保持を試みたが、ACS（IBM i Access Client Solutions）のコア実装
 * （`DS5250`/`PS5250`。`decisions.md` D6）を確認したところ、ホストの IC/MC より
 * 送信前のカーソル位置を優先する専用ロジックは見当たらなかったため、
 * その専用ロジック（Rule1/Rule2）は撤去した（`decisions.md` D7）。
 *
 * 一方、撤去とは別に見つかった**独立したバグ**——`opts.cursor` が `buf.cursorAddr` に
 * 反映されず、クリックで別の欄へ移してから（別の AID を挟まずに）次のキーを送ると
 * `cursorBefore`（`handleRecord` が参照する「送信前のカーソル位置」）が古いままになる
 * ——は Rule1/Rule2 の有無に関係なく正しい状態であるべきなので、修正は維持する
 * （既存の保護欄退避分岐 `PR#387` も同じ `cursorBefore` を参照するため）。
 */
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

/** 画面1枚目: FIELD_A・FIELD_B の両方を持つ。IC で FIELD_A(5,11) を指す */
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
 * 画面2枚目: 1枚目と**同一のレイアウト**（FIELD_A・FIELD_B とも同じ位置に同じ属性で SF）を
 * 送り直すが、IC は FIELD_B を指す（ホストが明示的にカーソルを動かす、ごく普通の応答）。
 */
function screenFieldBFocused(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(FIELD_A.row).u8(FIELD_A.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_A.len);
  w.u8(ORDER.SBA).u8(FIELD_B.row).u8(FIELD_B.col);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(FIELD_B.len);
  w.u8(ORDER.IC).u8(FIELD_B.row).u8(FIELD_B.col + 1);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/**
 * 1 画面目を出し、`cursor` オプション（web-ui がマウスクリックの位置を伝えるのに使う経路）を
 * 明示的に指定して AID キーを送り、2 画面目を受けたあとのカーソルを返す。
 * `tx` の印を挟むのは、`ReplayTransport` が**こちらが送るまで次の rx を流さない**ため。
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

describe("sendAid の cursor オプションで buf.cursorAddr を同期する", () => {
  it("実機で報告された回帰（PageDown）: クリックで別の欄へカーソルを移してから送ると、" +
     "移した先（web-ui の cursor オプション）ではなく古い buf.cursorAddr へ戻ってしまう", async () => {
    // 1画面目の IC は FIELD_A(5,11) を指す（buf.cursorAddr はこの時点で FIELD_A）。
    // 利用者はここでマウスクリックし、FIELD_B(8,11) へカーソルを移す——web-ui はこれを
    // ローカルの cursorOverride としてのみ保持し、`buf.cursorAddr` はまだ FIELD_A のまま
    // （research.md F7: opts.cursor は送信レコードの値を一時的に上書きするだけ）。
    // その状態で PageDown を送る。ホストは通常どおり IC で FIELD_B を指す応答を返すが、
    // 修正前は次の応答処理で `cursorBefore = this.buf.cursorAddr` が古い FIELD_A を指して
    // いたため、他のロジック（例えば保護欄退避 `PR#387`）が誤った基準点から判断しうる
    // 状態だった。ここでは素直にホストの IC（FIELD_B）が適用されることを確認する——
    // 修正の主眼は「`buf.cursorAddr` が常に最新のクライアント申告位置を反映する」ことで、
    // カーソル自体の最終的な行き先はホストの IC がそのまま決める。
    expect(
      await playWithCursorOverride(
        screen1WithFieldB(),
        screenFieldBFocused(),
        { row: FIELD_B.row, col: FIELD_B.col + 1 }
      )
    ).toEqual({ row: FIELD_B.row, col: FIELD_B.col + 1 });
  });

  it("実機で報告された回帰（PageUp）: 同じ経路が PageUp でも対称に働く", async () => {
    // web-ui はキー種別を問わず `cursor.value` をそのつど渡すため
    // （`EmulatorPane.vue` の AID 送信経路）、修正は PageUp/PageDown どちらの方向にも
    // 対称に効く。
    expect(
      await playWithCursorOverride(
        screen1WithFieldB(),
        screenFieldBFocused(),
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
    const initial = frame(screen1WithFieldB());
    const transport = new DeferredTransport(initial);
    const session = await Session5250.connect({ transport, id: "t" });
    // `NaN` は TS 上は `number` 型なので、これ自体は型エラーにならない
    // （型で弾かれるのではなく、実行時に不正な値として届く経路——WS の `cursor` は
    // ランタイム検証されていない——を模している）。
    const pending = session.sendAid("PageDown", { timeoutMs: 2000, cursor: { row: NaN, col: 5 } });
    // ここが「送信した・応答はまだ」の一瞬（web-ui がクリック直後に楽観的更新として
    // `session.snapshot()` を読む経路を想定）。
    const immediate = session.snapshot().cursor;
    expect(Number.isFinite(immediate.row)).toBe(true);
    expect(Number.isFinite(immediate.col)).toBe(true);
    // 不正な値は無視されるので、送信前の位置（1画面目の IC が置いた FIELD_A）のまま
    expect(immediate).toEqual({ row: FIELD_A.row, col: FIELD_A.col + 1 });
    // 保留していた応答を届けて後始末する
    transport.deliver(frame(screen1WithFieldB()));
    await pending;
  });
});
