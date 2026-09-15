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
 * `cursorBefore`（当時 `handleRecord` が参照していた「送信前のカーソル位置」）が
 * 古いままになる——は Rule1/Rule2 の有無に関係なく正しい状態であるべきなので、
 * 修正は維持する。
 *
 * **（`.aidev/works/20260915-pr387-acs-premise-unverified` での訂正）**:
 * 上記の `cursorBefore`、および当時これを参照していた保護欄退避分岐（`PR#387`）は、
 * その後この work で撤去した——「ACS は下の入力欄にカーソルを入れる」という前提が
 * 未検証だったと判明したため（`decisions.md` D2）。
 *
 * **`buf.cursorAddr` を同期する修正自体は引き続き必要だが、理由が入れ替わった**
 * ——`PR#387` 分岐が無くなった今、この同期が効くのは「ホストの応答を実際には
 * 処理しないまま `this.snapshot()` を返す経路」（Attn/SysReq の即時 return、
 * `sendAndWait()` のタイムアウト分岐）だけになった（`session.ts` の `sendAid()`
 * コメント参照）。
 *
 * **下の「実機で報告された回帰（PageDown/PageUp）」の2テストは、この新しい理由を
 * 検証していない**——どちらも2画面目に明示的な IC（`screenFieldBFocused()`）が
 * あり、`applyDataStream` がそれをそのまま `cursorAddr` へ上書きするため、この
 * 同期処理を無効化しても2テストとも green のまま（review 工程で実測確認済み）。
 * 元々このバグを再現した実機ケースの回帰確認として引き続き値はあるが、
 * discrimination（この work の変更後に効いている理由）としては
 * 「不正な cursor オプション」テストと、新設した「Attn は応答を待たず
 * `opts.cursor` を即座に反映する」テストが担う。
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
    // いたため、他のロジック（例えば当時の保護欄退避分岐 `PR#387`——その後
    // `.aidev/works/20260915-pr387-acs-premise-unverified` で撤去済み）が誤った基準点
    // から判断しうる状態だった。
    //
    // **この分岐は撤去済みのため、このテスト自体はもう discrimination になっていない**
    // ——ホストの明示的な IC（FIELD_B）が `applyDataStream` でそのまま適用されるだけで、
    // この同期処理の有無は結果を左右しない（ファイル冒頭の docblock 参照）。実機で
    // 踏んだ回帰の記録として残す。
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

  it("Attn は応答を待たず、直後の snapshot に opts.cursor をそのまま反映する", async () => {
    // **`PR#387` 分岐撤去後、この同期処理が実際に効く2つの経路のうちの1つ**
    // （もう1つは `sendAndWait()` のタイムアウト分岐。`session.ts` の `sendAid()`
    // コメント参照）。Attn はホストの応答を待たずに `this.snapshot()` を
    // 即座に返す——`DeferredTransport` で応答を意図的に止め、Attn の返り値
    // （`sendAid` の戻り値そのもの。応答未着でも解決される）が `opts.cursor` を
    // 反映していることを確認する。
    const initial = frame(screen1WithFieldB());
    const transport = new DeferredTransport(initial);
    const session = await Session5250.connect({ transport, id: "t" });
    // 1画面目の IC は FIELD_A(5,11)。ここで FIELD_B(8,11) へクリックしたことにする
    const result = await session.sendAid("Attn", {
      timeoutMs: 2000,
      cursor: { row: FIELD_B.row, col: FIELD_B.col + 1 }
    });
    // Attn は応答を待たないため、DeferredTransport が応答を一切届けなくても解決される
    expect(result.timedOut).toBe(false);
    expect(result.screen.cursor).toEqual({ row: FIELD_B.row, col: FIELD_B.col + 1 });
    expect(session.snapshot().cursor).toEqual({ row: FIELD_B.row, col: FIELD_B.col + 1 });
  });
});
