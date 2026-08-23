import { describe, it, expect } from "vitest";
import { codecForCcsid } from "@ts5250/ebcdic";
import { parseRecord } from "../src/protocol/gds.js";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import {
  detectPcoMarker,
  PCO_START,
  PCO_END,
  PCCMD_MAX_CHARS,
  PCO_SCAN_BYTES,
  readPcCommand
} from "../src/protocol/pc-command.js";
import { ScreenBuffer } from "../src/screen/buffer.js";

/**
 * PC Organizer（STRPCCMD）の標識検出。
 *
 * **fixture は実機（IBM i 7.x・CCSID 939・27x132）の受信レコードそのもの**。
 * 合成データではなく実測を置くのは、標識の前に日本語 DBCS・WDSF（罫線）・非表示属性が
 * 並ぶ「本物の並び」で誤検出・取りこぼしが起きないことを確かめるため
 * （`.aidev/works/20260728-strpco-strpccmd/research.md` D1）。
 */

/** STRPCCMD PCCMD('echo NOWAIT') PAUSE(*NO) の受信レコード */
const REC_PAUSE_NO =
  "010b12a0000004000003044004110028010700000019000000150009d960018000000011010227402040004040004027" +
  "40201102022740204000404000402740201101011d482027040a111012200e47ca4655449642d742c343d743bb43c243" +
  "ad43a60f4dd7c3d64bc5e7c55d0e44c047b445e4485248fd4497449644564494448244a4448f44bd43410f2011111220" +
  "0e42d742c3449545e345a5448e44af448a4495449d44cd448744a4448f44bd43410f4020111212200e48eb46cd499044" +
  "8e44af449144a74497449d426b45ed45a443874358444649e1448d4494448844ca448c448243410f201101012780fcd7" +
  "c3d6408380a180818583889640d5d6e6c1c9e3020d4b0004520000";

/** STRPCCMD PCCMD('echo WAITME') PAUSE(*YES)。上との差は PAUSE 標識 1 バイトと本文だけ */
const REC_PAUSE_YES =
  "010b12a0000004000003044004110028010700000019000000150009d960018000000011010227402040004040004027" +
  "40201102022740204000404000402740201101011d482027040a111012200e47ca4655449642d742c343d743bb43c243" +
  "ad43a60f4dd7c3d64bc5e7c55d0e44c047b445e4485248fd4497449644564494448244a4448f44bd43410f2011111220" +
  "0e42d742c3449545e345a5448e44af448a4495449d44cd448744a4448f44bd43410f4020111212200e48eb46cd499044" +
  "8e44af449144a74497449d426b45ed45a443874358444649e1448d4494448844ca448c448243410f201101012780fcd7" +
  "c3d6408380a180808583889640e6c1c9e3d4c5020d4b0004520000";

/** 123 文字のコマンド。1 行（132 桁）を越えて折り返すが、ホストは SBA を挟まない（research D4） */
const REC_LONG =
  "017b12a0000004000003044004110028010700000019000000150009d960018000000011010227402040004040004027" +
  "40201102022740204000404000402740201101011d482027040a111012200e47ca4655449642d742c343d743bb43c243" +
  "ad43a60f4dd7c3d64bc5e7c55d0e44c047b445e4485248fd4497449644564494448244a4448f44bd43410f2011111220" +
  "0e42d742c3449545e345a5448e44af448a4495449d44cd448744a4448f44bd43410f4020111212200e48eb46cd499044" +
  "8e44af449144a74497449d426b45ed45a443874358444649e1448d4494448844ca448c448243410f201101012780fcd7" +
  "c3d6408380a18081e7f0f0f4f5f6f7f8f9f0e7f0f1f4f5f6f7f8f9f0e7f0f2f4f5f6f7f8f9f0e7f0f3f4f5f6f7f8f9f0" +
  "e7f0f4f4f5f6f7f8f9f0e7f0f5f4f5f6f7f8f9f0e7f0f6f4f5f6f7f8f9f0e7f0f7f4f5f6f7f8f9f0e7f0f8f4f5f6f7f8" +
  "f9f0e7f0f9f4f5f6f7f8f9f0e7f1f0f4f5f6f7f8f9f0e7f1f1f4f5f6f7f8f9f0e9e9e9020d4b0004520000";

const hex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));

const codec = codecForCcsid(939);

function apply(record: string) {
  const buf = new ScreenBuffer({ alternate: "27x132" });
  const parsed = parseRecord(hex(record));
  return { result: applyDataStream(parsed.data, buf, codec), buf };
}

describe("PC Organizer の標識検出（実機レコード）", () => {
  it("PAUSE(*NO) は待たない指定として、コマンド本文を取り出す", () => {
    const { result } = apply(REC_PAUSE_NO);
    expect(result.pcCommand).toEqual({ command: "echo NOWAIT", wait: false, truncated: false });
    expect(result.pcCommandEnd).toBeUndefined();
  });

  it("PAUSE(*YES) は待つ指定になる（差は標識直後の 1 バイトだけ）", () => {
    const { result } = apply(REC_PAUSE_YES);
    expect(result.pcCommand).toEqual({ command: "echo WAITME", wait: true, truncated: false });
  });

  it("行を跨ぐ 123 文字のコマンドも欠けずに読める", () => {
    const { result } = apply(REC_LONG);
    const expected =
      "X004567890X014567890X024567890X034567890X044567890X054567890" +
      "X064567890X074567890X084567890X094567890X104567890X114567890ZZZ";
    expect(result.pcCommand?.command).toBe(expected);
    expect(result.pcCommand?.command.length).toBe(123);
  });

  it("ホストはこの画面で READ を出しているので、応答待ちとして扱う", () => {
    const { result } = apply(REC_PAUSE_NO);
    expect(result.readRequested).toBe(true);
  });

  it("コマンド本文は非表示属性の下なので画面には出ない（core でマスクされる）", () => {
    const { buf } = apply(REC_PAUSE_NO);
    const snap = buf.snapshot("t", false);
    const row1 = snap.cells[0]!;
    // 桁 1 の非表示属性が効いていて、本文が並ぶ桁（13〜）は空白へマスクされる
    // （属性桁そのものは直前の属性で描かれるため 13 桁目を見る）
    expect(row1[12]!.nonDisplay).toBe(true);
    expect(row1.map((c) => c.char).join("")).not.toContain("echo");
  });
});

describe("detectPcoMarker", () => {
  it("開始標識と終了標識を見分ける", () => {
    expect(detectPcoMarker(Uint8Array.from(PCO_START))).toBe("start");
    expect(detectPcoMarker(Uint8Array.from(PCO_END))).toBe("end");
  });

  it("1 バイトでも違えば検出しない", () => {
    const near = Uint8Array.from(PCO_START);
    near[7] = 0x84; // 0x83 -> 0x84
    expect(detectPcoMarker(near)).toBeUndefined();
  });

  it("標識より短ければ検出しない（レコード末尾で例外にしない）", () => {
    expect(detectPcoMarker(Uint8Array.from(PCO_START.slice(0, 10)))).toBeUndefined();
    expect(detectPcoMarker(Uint8Array.from([]))).toBeUndefined();
  });

  it("非表示属性が並ぶだけの通常画面は検出しない", () => {
    // 実機レコードから標識部分を取り除いた並び（属性 0x27 のあとに普通の文字）
    expect(detectPcoMarker(hex("27404040404040404040404040"))).toBeUndefined();
  });
});

describe("通常の画面では PC コマンドを検出しない", () => {
  it("同じレコードでも標識バイトを 1 つ崩せば検出されない", () => {
    // 0x83（標識 8 バイト目）を 0x84 に変える。他は実機のまま
    const broken = REC_PAUSE_NO.replace("2780fcd7c3d6408380a180", "2780fcd7c3d6408480a180");
    expect(broken).not.toBe(REC_PAUSE_NO);
    const { result } = apply(broken);
    expect(result.pcCommand).toBeUndefined();
    expect(result.pcCommandEnd).toBeUndefined();
  });
});

/**
 * **DBCS を含むコマンド本文**（backlog `pc-command.md`）。
 *
 * 標識の読み取りは SBCS 前提で書かれていた——1 バイトずつ復号し、`0x40` 未満で終端と見なす。
 * **SO(0x0e) は `0x40` 未満**なので、日本語を含むコマンドは**最初の全角文字で切れていた**。
 *
 * `notepad 日本語.txt` は `notepad ` だけになり、**引数の無い notepad が起動する**。
 * 実行してしまう以上、これは黙って間違ったことをする類の欠陥。
 *
 * ⚠ 本文だけを差し替え、**標識の前後は実機レコードのまま**使う（合成した頭では
 * 前置きの orders が違ってしまい、本物の並びで確かめたことにならない）。
 */

/** 実機レコードの、標識に至るまでのデータ部 */
const REAL_PREFIX = ((): Uint8Array => {
  const data = parseRecord(hex(REC_PAUSE_NO)).data;
  for (let i = 0; i + PCO_START.length <= data.length; i++) {
    if (PCO_START.every((b, k) => data[i + k] === b)) return data.slice(0, i);
  }
  throw new Error("fixture に標識が無い");
})();

/** RA で本文を終え、READ MDT FIELDS で締める（実機レコードの尻尾と同じ） */
const REAL_SUFFIX = [0x02, 0x0d, 0x4b, 0x00, 0x04, 0x52, 0x00, 0x00];

function streamOf(body: readonly number[], suffix: readonly number[] = REAL_SUFFIX): Uint8Array {
  return Uint8Array.from([...REAL_PREFIX, ...PCO_START, 0x81, ...body, ...suffix]);
}

function runStream(body: readonly number[], suffix?: readonly number[]) {
  const buf = new ScreenBuffer({ alternate: "27x132" });
  const warns: string[] = [];
  const result = applyDataStream(streamOf(body, suffix), buf, codec, (m) => warns.push(m));
  return { result, warns };
}

describe("DBCS を含む本文", () => {
  const sbcs = (t: string): number[] => [...codec.encode(t).bytes];
  const readBody = (t: string): string | undefined => runStream(sbcs(t)).result.pcCommand?.command;

  it("**全角を含む本文が最後まで読める**（以前は SO で切れていた）", () => {
    expect(sbcs("notepad 日本語.txt"), "SO が入っていること自体を確かめる").toContain(0x0e);
    expect(readBody("notepad 日本語.txt")).toBe("notepad 日本語.txt");
  });

  it("全角のあとに半角が続いても崩れない（SI で戻る）", () => {
    expect(readBody("start 表計算 /B a.exe")).toBe("start 表計算 /B a.exe");
  });

  it("全角だけの本文も読める", () => {
    expect(readBody("日本語")).toBe("日本語");
  });

  it("**SI で閉じないまま終わっても落ちない**（並びが壊れたレコード）", () => {
    // SO のあと DBCS 対を 1 つ置いて、SI を付けずにオーダーで終える
    const { result } = runStream([0x0e, 0x44, 0xc0]);
    expect(result.pcCommand?.truncated).toBe(false);
    expect(result.pcCommand?.command).toHaveLength(1);
  });
});

/**
 * **上限いっぱいの本文**（backlog `pc-command.md` の「V7R2 以降の `PCCMD` 1023 文字上限」）。
 *
 * 先読み窓は **512 バイト**だった。V7R2 以降のホストは **1023 文字**まで送れるので、
 * 約 500 バイトを越える本文は**黙って切れていた**——切れたことすら分からない。
 * `del a.txt b.txt` が `del a.txt` になる類で、**実行してしまうと実害が出る**。
 */
describe("長い本文", () => {
  const ascii = (n: number): number[] => [...codec.encode("A".repeat(n)).bytes];
  /**
   * 長い本文では実機尻尾の `RA (13,75)` が**使えない**——本文がその桁を追い越すので
   * `RA target < current` になる。ESC で締める（`0x04` も `0x40` 未満＝本文の終わり）
   */
  const ESC_READ = [0x04, 0x52, 0x00, 0x00];

  it("**上限 1023 文字が欠けずに読める**（以前は約 500 で切れた）", () => {
    const { result } = runStream(ascii(PCCMD_MAX_CHARS), ESC_READ);
    expect(result.pcCommand?.command).toHaveLength(PCCMD_MAX_CHARS);
    expect(result.pcCommand?.truncated).toBe(false);
  });

  it("以前の窓（512）を越える長さでも読める", () => {
    expect(runStream(ascii(600), ESC_READ).result.pcCommand?.command).toHaveLength(600);
  });

  /**
   * ここだけ `readPcCommand` を直に呼ぶ。窓ぶん（2122 バイト）の本文は
   * **24x80 の画面に入りきらない**ので、applier 経由では書き込みで先に落ちる。
   * 見たいのは「窓を使い切ったと分かるか」なので、読み取り側で確かめる。
   */
  it("窓を使い切ったら **truncated** が立つ（終端に届いていない）", () => {
    const data = Uint8Array.from([...PCO_START, 0x81, ...ascii(PCO_SCAN_BYTES)]);
    expect(readPcCommand(data, (b) => codec.decode(b)).truncated).toBe(true);
  });

  it("終端オーダーに届けば **truncated** は立たない", () => {
    const data = Uint8Array.from([...PCO_START, 0x81, ...ascii(50), 0x02]);
    const req = readPcCommand(data, (b) => codec.decode(b));
    expect(req.truncated).toBe(false);
    expect(req.command).toHaveLength(50);
  });
});
