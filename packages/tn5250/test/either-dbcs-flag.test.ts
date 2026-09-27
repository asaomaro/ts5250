import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { buildReadMdtResponse } from "../src/protocol/read-response.js";
import { parseRecord } from "../src/protocol/gds.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { ESC, COMMAND, ORDER, FFW } from "../src/protocol/constants.js";
import { rawSentinel } from "../src/screen/attr-sentinel.js";

/**
 * **E（either）欄の全角の状態は欄ごとに持ち続ける**（ACS `Field5250.EitherFieldDBCSOn`。`20260927-either-field-mode`）。
 * 立つのはホストが欄の先頭に SO/SI を書いたとき（ACS の表示データの書き込み）と全角で始まる値を書いたとき、下りるのは半角で始まる値を書いたときだけ。
 * 空の値では変えない——ACS は欄を消しても SO/SI を残して全角のままにする（`PS5250.eraseField_Work`）
 */
function eField(): { b: ScreenBuffer; flag: () => boolean | undefined } {
  const b = new ScreenBuffer();
  b.addField(b.addrOf(5, 20), 12, FFW.ID_VALUE, 0x24, "either");
  return { b, flag: () => b.snapshot("s", false).fields[0]!.eitherDbcsOn };
}

describe("E 欄の全角の状態", () => {
  it("既定は付かない（半角の状態）", () => {
    expect(eField().flag()).toBeUndefined();
  });

  it("**ホストが欄の先頭に SO を書くと全角の状態**（中身が空の `SO SI` でも）", () => {
    const { b, flag } = eField();
    b.setShift(b.addrOf(5, 20), "so");
    b.setShift(b.addrOf(5, 21), "si");
    expect(flag()).toBe(true);
  });

  it("欄の途中の SO では変わらない", () => {
    const { b, flag } = eField();
    b.setShift(b.addrOf(5, 23), "so");
    expect(flag()).toBeUndefined();
  });

  it("**全角で始まる値で立ち、半角で始まる値で下りる。空の値では変えない**", () => {
    const { b, flag } = eField();
    const f = b.fieldByIndex(1);
    b.setFieldValue(f, "あい", true);
    expect(flag()).toBe(true);
    b.setFieldValue(f, "", true);
    expect(flag()).toBe(true);
    b.setFieldValue(f, "   ", true);
    expect(flag()).toBe(true);
    b.setFieldValue(f, "X", true);
    expect(flag()).toBeUndefined();
    b.setFieldValue(f, "　あ", true);
    expect(flag()).toBe(true);
  });

  it("未編集の DBCS 欄の値（SO のセンチネルで始まる）を書き戻しても全角のまま", () => {
    const { b, flag } = eField();
    const f = b.fieldByIndex(1);
    b.setFieldValue(f, rawSentinel(0x0e) + rawSentinel(0x44) + rawSentinel(0x86) + rawSentinel(0x0f), true);
    expect(flag()).toBe(true);
  });

  it("E 欄でなければ付かない（O 欄・SBCS 欄）", () => {
    const b = new ScreenBuffer();
    b.addField(b.addrOf(5, 20), 12, FFW.ID_VALUE, 0x24, "open");
    b.setShift(b.addrOf(5, 20), "so");
    b.setFieldValue(b.fieldByIndex(1), "あ", true);
    expect(b.snapshot("s", false).fields[0]!.eitherDbcsOn).toBeUndefined();
  });

  it("**同じ位置の欄を定義し直しても（SF）全角の状態は残る**（ACS `FFT5250.addFieldToFFT` は同じ位置の欄を使い回す）", () => {
    const { b, flag } = eField();
    b.setFieldValue(b.fieldByIndex(1), "あ", true);
    // SF で同じ位置に定義し直す（`applySf` が `checkNewField` で FFW だけ書き換える。`20260927-wtd-sense-rest`）
    const r = applyDataStream(
      Uint8Array.from([ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 19, ORDER.SF, 0x40, 0x00, 0x82, 0x40, 0x24, 0x00, 0x0c]),
      b, codecForCcsid(930), () => {}
    );
    expect(r.senseCode).toBeUndefined();
    expect(flag()).toBe(true);
  });

  it("**CLEAR UNIT で欄の表ごと捨てたら消える**（新しく定義した欄は半角の状態）", () => {
    const { b, flag } = eField();
    b.setFieldValue(b.fieldByIndex(1), "あ", true);
    b.clearUnit();
    b.addField(b.addrOf(5, 20), 12, FFW.ID_VALUE, 0x24, "either");
    expect(flag()).toBeUndefined();
  });

  it("申告のある DBCS 欄に `dbcsContent` を付けない（`eitherDbcsOn` を足しても else の相手を変えない）", () => {
    const b = new ScreenBuffer();
    b.addField(b.addrOf(5, 20), 12, FFW.ID_VALUE, 0x24, "only");
    b.setShift(b.addrOf(5, 20), "so");
    b.setDbcs(b.addrOf(5, 21), "あ", 0x44, 0x81);
    b.setShift(b.addrOf(5, 23), "si");
    const f = b.snapshot("s", false).fields[0]!;
    expect(f.dbcsType).toBe("only");
    expect(f.dbcsContent).toBeUndefined();
    expect(f.eitherDbcsOn).toBeUndefined();
  });
});

/**
 * **画面の側が明示した状態は、値からの推定より優先する**（`setFieldValue` の `opts.eitherDbcsOn`。`20260927-either-field-so`）。
 * コアは空の値では状態を変えない（`noteEitherMode`）ため、画面の側で「切り替えてから空にした」という事実を伝えないと、
 * 前の全角の状態が誤って残る——独立点検で見つかった実例をそのまま固定する
 */
describe("空にした E 欄: 画面の側の状態を渡したとき", () => {
  it("**全角のまま空にした**と伝えると、状態は全角のまま・欄の先頭に SO だけを置く（ACS は `0e` を送る）", () => {
    const { b, flag } = eField();
    b.setFieldValue(b.fieldByIndex(1), "あい", true);
    expect(flag()).toBe(true);
    b.setFieldValue(b.fieldByIndex(1), "", true, { eitherDbcsOn: true });
    expect(flag(), "全角のまま").toBe(true);
    const cell = b.snapshot("s", false).cells[4]![19]!; // (5,20) の先頭桁
    expect(cell.kind).toBe("so");
  });

  it("**半角へ切り替えてから空にした**と伝えると、状態は半角に落ちる（レビューで見つかった不具合の再発防止）", () => {
    const { b, flag } = eField();
    b.setFieldValue(b.fieldByIndex(1), "あい", true); // 全角の状態にしておく
    expect(flag()).toBe(true);
    // 画面の側は「X を打って半角へ切り替え、そのまま消した」と伝える（値は空）
    b.setFieldValue(b.fieldByIndex(1), "", true, { eitherDbcsOn: false });
    // スナップショットは true のときだけ載せる（false は undefined と同じ扱い。`snapshot()` の注記）
    expect(flag(), "半角に落ちる——渡さない場合は真のまま残ってしまう").toBeUndefined();
    const cell = b.snapshot("s", false).cells[4]![19]!;
    expect(cell.kind).not.toBe("so");
  });

  it("状態を渡さない呼び出し（MCP・HLLAPI・マクロ）は従来どおり値から推す——空では変えない", () => {
    const { b, flag } = eField();
    b.setFieldValue(b.fieldByIndex(1), "あい", true);
    expect(flag()).toBe(true);
    b.setFieldValue(b.fieldByIndex(1), "", true); // opts 無し
    expect(flag(), "推定は空の値を変えない").toBe(true);
  });

  it("**空白だけの値でも READ は `0e` だけ**（残りの桁は NUL。空白を残すと `0e 40 40 …` になる）", () => {
    const b = new ScreenBuffer();
    applyDataStream(Uint8Array.from([ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 19, ORDER.SF, 0x40, 0x00, 0x82, 0x40, 0x24, 0x00, 0x0c]), b, codecForCcsid(930), () => {});
    b.setFieldValue(b.fieldByIndex(1), "            ", true, { eitherDbcsOn: true });
    const data = parseRecord(buildReadMdtResponse(b, codecForCcsid(930), 0xf1, { row: 5, col: 20 }).record).data.subarray(3);
    expect([...data].map((x) => x.toString(16).padStart(2, "0")).join("")).toBe("110514" + "0e");
  });

  it("**J（DBCS のみ）の欄を空にすると SO と SI を残す**（ACS は Erase Input の後の J 欄を `0e`＋NUL＋`0f` で送る。0x52 では NUL は 0x40）", () => {
    const b = new ScreenBuffer();
    applyDataStream(Uint8Array.from([ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00, ORDER.SBA, 5, 19, ORDER.SF, 0x40, 0x00, 0x82, 0x00, 0x24, 0x00, 0x06]), b, codecForCcsid(930), () => {});
    b.setFieldValue(b.fieldByIndex(1), "", true);
    const data = parseRecord(buildReadMdtResponse(b, codecForCcsid(930), 0xf1, { row: 5, col: 20 }).record).data.subarray(3);
    expect([...data].map((x) => x.toString(16).padStart(2, "0")).join("")).toBe("110514" + "0e404040400f");
  });

  it("継続欄の中間・最終の区間には SO を置かない（SO は欄の頭にだけある。E・J の継続欄は未確認）", () => {
    const b = new ScreenBuffer();
    applyDataStream(Uint8Array.from([ESC, COMMAND.CLEAR_UNIT, ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
      ORDER.SBA, 5, 19, ORDER.SF, 0x40, 0x00, 0x82, 0x00, 0x86, 0x01, 0x24, 0x00, 0x06,
      ORDER.SBA, 6, 19, ORDER.SF, 0x40, 0x00, 0x82, 0x00, 0x86, 0x02, 0x24, 0x00, 0x06]), b, codecForCcsid(930), () => {});
    b.setFieldValue(b.fieldByIndex(2), "", true);
    expect(b.snapshot("s", false).cells[5]![19]!.kind).not.toBe("so");
  });
});

