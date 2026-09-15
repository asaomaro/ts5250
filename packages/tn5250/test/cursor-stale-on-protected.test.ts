import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { ReplayTransport } from "../src/trace/replay.js";
import { bytesToHex, type TraceEntry } from "../src/trace/trace.js";
import { buildRecord } from "../src/protocol/gds.js";
import { ByteWriter } from "../src/protocol/bytes.js";
import { ESC, COMMAND, ORDER, OPCODE, FFW } from "../src/protocol/constants.js";
import { IAC, CMD } from "../src/telnet/constants.js";

/**
 * **画面が変わったのにカーソルが動かず、そこが入力できない桁なら、最初の入力欄へ寄せる。**
 *
 * 「上で入力 → Enter → 上がプロテクトされ、下が展開する」画面で踏む。アプリはカーソルを
 * 動かしておらず、ホストが送るのは operator が居た桁のまま＝いまは保護欄。ACS は下の
 * 入力欄にカーソルを入れるが、こちらは保護欄に置いたままで、Tab を押すまで打てなかった
 * （利用者の報告。実機 ASAOLIB/CURSORCL3 で再現し、`scripts/diag-ic-on-protected.mjs` で計測）。
 *
 * **「動いていない」を条件にするのが肝。** ホストが**わざと**保護欄を指す画面があり
 * （SEU の走査検索は見つかった桁にカーソルを置く）、そちらを寄せると「どこが見つかったか
 * 分からない」に戻る。実機で並べると 展開画面 3/12→3/12（動かない）／SEU 2/9→11/53（動く）。
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

/** 入力欄 1 つ（3 行 12 桁）＋ IC でそこを指す画面 */
function firstScreen(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(3).u8(11);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(6); // 入力欄 → (3,12) から 6 桁
  w.u8(ORDER.IC).u8(3).u8(12);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/**
 * 2 画面目。上の欄は保護（BYPASS）になり、下に入力欄が出る。
 * `ic` を渡すとその桁を指す（渡さなければカーソルは 1 画面目のまま＝動かない）。
 */
function secondScreen(ic?: { row: number; col: number }): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(3).u8(11);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE | FFW.BYPASS).u8(0x20).u16(6); // 保護になった上の欄
  w.u8(ORDER.SBA).u8(10).u8(11);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(10); // 展開した下の入力欄 → (10,12)
  if (ic) w.u8(ORDER.IC).u8(ic.row).u8(ic.col);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

/**
 * 1 画面目を出し、指定した AID キー（既定 Enter）を送って 2 画面目を受けたあとの
 * カーソルを返す。`tx` の印を挟むのは、`ReplayTransport` が**こちらが送るまで次の rx を
 * 流さない**ため。
 */
async function play(
  second: Uint8Array,
  aid: "Enter" | "PageUp" | "PageDown" = "Enter"
): Promise<{ row: number; col: number }> {
  const transport = new ReplayTransport([
    rx(firstScreen()),
    { ts: "t", dir: "tx", masked: true, len: 0 },
    rx(second)
  ]);
  const session = await Session5250.connect({ transport, id: "t" });
  // 1 画面目でカーソルが上の欄に付いていること（前提）
  expect(session.snapshot().cursor).toEqual({ row: 3, col: 12 });
  await session.sendAid(aid, { timeoutMs: 2000 });
  return session.snapshot().cursor;
}

describe("カーソルが保護欄に取り残されたら最初の入力欄へ寄せる", () => {
  it("カーソルが動かず保護欄なら、展開した下の入力欄へ寄せる", async () => {
    // IC 無し＝カーソルは 1 画面目のまま（3,12）。そこは保護になっている
    expect(await play(secondScreen())).toEqual({ row: 10, col: 12 });
  });

  it("ホストが同じ桁を**わざと**指しても寄せる（動いていないので同じ扱い）", async () => {
    expect(await play(secondScreen({ row: 3, col: 12 }))).toEqual({ row: 10, col: 12 });
  });

  /** **動かした指定は尊重する**（SEU の走査検索。寄せると見つかった桁が分からなくなる） */
  it("ホストがカーソルを動かして保護欄を指したら、そこに置いたまま", async () => {
    expect(await play(secondScreen({ row: 3, col: 15 }))).toEqual({ row: 3, col: 15 });
  });

  it("動いていなくても入力欄なら触らない", async () => {
    expect(await play(secondScreen({ row: 10, col: 12 }))).toEqual({ row: 10, col: 12 });
  });
});

/**
 * **「動いていない・保護欄」の判定条件は、AID キー種別ではなく「送信前は入力可能
 * だったか」（`cursorBeforeWasEnterable`）で決める。**
 *
 * SEU でカーソルを保護欄（本文の表示領域。入力欄でも `SEU==>` でもない）に置いた状態で
 * PageUp/PageDown すると、カーソルがヘッダーの入力可能エリアへ強制移動する不具合が
 * 利用者から報告された。実機トレースで、カーソルがあった論理行が新しいページに
 * もう見えない場合、**ホストは IC/MC を明示的に送ってくるが、送信前と同じ物理位置
 * （保護欄）を指す**——`cursorSet=true` かつ `cursorAddr === cursorBefore` かつ
 * `cursorIsUnenterable()` という、上の describe と同じ `PR#387` 分岐の発火条件に
 * 一致してしまい、誤って先頭入力欄へ強制移動していた
 * （`.aidev/works/20260915-pdm-protected-cursor-pageup` research.md F2〜F4）。
 *
 * **当初は「直前に送信した AID キーが PageUp/PageDown か」で判定していたが
 * （`decisions.md` D2〜D4）、利用者の指摘（「ホストが位置を送ってくるなら、キー種別に
 * 関係なくホストに従えば良いのでは。ACS にキー判定の特殊対応があるのか」）を受けて
 * 実機で再検証したところ、ACS のデコンパイル済みコアにキー種別による分岐は無く
 * （`.aidev/works/20260914-seu-page-cursor-hold` decisions.md D6）、より正確な判定条件が
 * 見つかった（`decisions.md` D5）。**
 *
 * 実機で両シナリオの「送信前の桁」を直接調べると、SF定義された欄の**保護状態そのもの**が
 * 違う:
 *   展開画面（Enter） … 3/12 は送信前は**入力可能**な欄。このレコードで保護化される
 *   SEU PageUp/PageDown … 10/10 は送信前から**ずっと保護**（SF定義はあるが常にBYPASS）
 * `cursorBeforeWasEnterable`（このレコードを当てる**前**、その桁は入力可能だったか）を
 * 条件に加えると、AID キー種別を一切見ずに両方を正しく判別できる——PageUp/PageDown でも、
 * もし本当に「送信前は入力可能だった欄がこの応答で保護化された」なら**引き続き寄せる**
 * （下の3つ目（最後）のテストで確認）。
 */
describe("動いていない保護欄への既定動作は「送信前に入力可能だったか」で決まる", () => {
  /** SF定義された保護欄1桁（(5,20)）と、入力欄1つ（(3,12)〜、寄せ先になりうる）。
   *  SEU の本文表示領域と同じ形——**SF はあるが、送信前からずっと BYPASS**。 */
  function alwaysProtectedScreen(): Uint8Array {
    const w = new ByteWriter();
    w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
    w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
    w.u8(ORDER.SBA).u8(3).u8(11);
    w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(6); // 入力欄 → (3,12)〜(3,17)
    w.u8(ORDER.SBA).u8(5).u8(19);
    w.u8(ORDER.SF).u16(FFW.ID_VALUE | FFW.BYPASS).u8(0x20).u16(1); // 保護欄 → (5,20)。常にBYPASS
    w.u8(ORDER.IC).u8(5).u8(20);
    w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
    return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
  }

  /**
   * 1画面目・2画面目とも**同じ**「常に保護」画面を送る（SEU が同じ書式でページを
   * 再描画するのと同じ形。ホストは毎回 (5,20) へ IC で明示的に指し直す）。
   */
  async function playPage(dir: "PageUp" | "PageDown"): Promise<{ row: number; col: number }> {
    const transport = new ReplayTransport([
      rx(alwaysProtectedScreen()),
      { ts: "t", dir: "tx", masked: true, len: 0 },
      rx(alwaysProtectedScreen())
    ]);
    const session = await Session5250.connect({ transport, id: "t" });
    expect(session.snapshot().cursor).toEqual({ row: 5, col: 20 }); // 前提: 保護欄にいる
    await session.sendAid(dir, { timeoutMs: 2000 });
    return session.snapshot().cursor;
  }

  it("PageDown でホストが同じ『送信前からずっと保護』の欄を指し直しても、カーソル位置を維持する", async () => {
    expect(await playPage("PageDown")).toEqual({ row: 5, col: 20 });
  });

  it("PageUp でも対称に働く", async () => {
    expect(await playPage("PageUp")).toEqual({ row: 5, col: 20 });
  });

  /**
   * **AID キー種別では判定していないことの確認。** 上の2テストと違い、こちらは
   * 「送信前は入力可能だった欄が、この応答で本当に保護化される」という
   * `firstScreen()`/`secondScreen()`（上の describe と同じ、Enter用の展開画面）を使う。
   * **`secondScreen({row:3,col:12})` で、ホストが同じ（もう保護化された）位置へ
   * IC を明示的に指し直す形にする**——`cursorSet=true` かつ動いていない、という
   * `PR#387` 分岐そのものを PageDown 経由で発火させる（`ic` を省略すると
   * `cursorSet=false` になり `!result.cursorSet` 分岐（元々無条件）を通ってしまい、
   * `PR#387` 分岐の `cursorBeforeWasEnterable` を検証したことにならない）。
   * PageDown を送っても、キー種別に関係なく寄せられることを示す
   * （もし旧実装のように AID キーだけで判定していたら、これは寄らずに失敗する）。
   */
  it("送信前に入力可能だった欄が保護化された場合は、PageDown でも寄せる（キー種別では判定しない）", async () => {
    expect(await play(secondScreen({ row: 3, col: 12 }), "PageDown")).toEqual({ row: 10, col: 12 });
  });
});
