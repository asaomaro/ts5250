/**
 * **帳票 1 行を「描くための区間」に分ける。** 画面（web-ui の `ReportText`）と
 * 配布 HTML（`spool-html.ts`）が**同じ関数を通る**ようにするための層。
 *
 * 分けているのは 3 つの都合だけで、帳票そのものは属性を持たない（SCS は色も強調も無い）:
 *
 * - **全角**は 2 桁の箱に入れる必要がある（フォントに桁幅を委ねない）
 * - **読みで字が変わる区間**は 2 通りの字を持つ（表示コード切替。カナ ⇄ 英）
 * - **SO/SI** は印を描く位置を持つ
 *
 * ここを 1 か所にしておかないと、「画面ではこう見えるのに保存した HTML では違う」が起きる。
 * 桁と文字列の添字は**一致しない**（全角が 1 文字で 2 桁を占める）ので、桁は別に数える。
 */
import { isFullWidth } from "@ts5250/base";
import { katakanaChar, latinChar } from "@ts5250/ebcdic/katakana";
import type { ShiftMark } from "./scs.js";

/** SBCS の読み。カナ（CP290 系）／英（CP1027 系） */
export type SbcsReading = "kana" | "latin";

/** 行を分けた 1 区間 */
export type ReportSeg =
  /** 半角の連なり。`alt` があれば読みで字が変わる（無ければどちらの読みでも同じ） */
  | { kind: "text"; text: string; alt?: string }
  /** 全角 1 文字（2 桁の箱に入れる） */
  | { kind: "wide"; text: string }
  /** SO/SI の印。**桁を 1 つ借りる**（SCS の SO/SI は桁を占めないため、出すと右へずれる） */
  | { kind: "mark"; text: "{" | "}" };

/**
 * 描けない字を半角スペースに落とす。
 *
 * EBCDIC の SBCS 表は 256 バイト中 96 バイトを制御文字（C0 / DEL / C1）へ写すので、
 * 読み直した先が制御文字になることがある。そのまま出すと豆腐（□）になり、
 * マップの無いバイトを表す U+FFFD は**多くのフォントで全角幅**なので桁までずれる。
 */
export function displayableChar(ch: string): string {
  const c = ch.codePointAt(0);
  if (c === undefined) return " ";
  return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xfffd ? " " : ch;
}

/** 生バイトを指定の読みで読み直す */
function recode(byte: number, reading: SbcsReading): string {
  return displayableChar(reading === "kana" ? katakanaChar(byte) : latinChar(byte));
}

/**
 * 1 行を区間に分ける。
 *
 * @param line   `LogicalPage.lines` の 1 行
 * @param raw    `LogicalPage.raw` の同じ行（桁ごとの生バイト）。無ければ読み直さない
 * @param shifts `LogicalPage.shifts` の同じ行（SO/SI の位置）。`marks` が false なら使わない
 * @param alt    もう一方の読み。`undefined` なら 1 通りだけ
 * @param marks  SO/SI の印を区間に入れるか
 */
export function reportLineSegs(
  line: string,
  raw: readonly (number | undefined)[] = [],
  shifts: readonly ShiftMark[] = [],
  alt?: SbcsReading,
  marks = false
): ReportSeg[] {
  const out: ReportSeg[] = [];
  let run = "";
  let runAlt = "";
  let runDiff = false;
  let col = 1;
  const flush = (): void => {
    if (run === "") return;
    out.push(runDiff ? { kind: "text", text: run, alt: runAlt } : { kind: "text", text: run });
    run = "";
    runAlt = "";
  };
  const putMarks = (at: number): void => {
    if (!marks) return;
    for (const m of shifts) {
      if (m.col !== at) continue;
      flush();
      out.push({ kind: "mark", text: m.kind === "so" ? "{" : "}" });
    }
  };
  for (const ch of line) {
    putMarks(col);
    if (isFullWidth(ch)) {
      flush();
      out.push({ kind: "wide", text: ch });
      col += 2;
      continue;
    }
    const b = raw[col - 1];
    const altCh = alt === undefined || b === undefined ? ch : recode(b, alt);
    const diff = altCh !== ch;
    if (diff !== runDiff) {
      flush();
      runDiff = diff;
    }
    run += ch;
    runAlt += altCh;
    col += 1;
  }
  flush();
  putMarks(col); // 行末で閉じる SI
  return out;
}

/** その行に「読み直すと字が変わる桁」があるか */
export function lineHasAlt(
  line: string,
  raw: readonly (number | undefined)[] | undefined,
  alt: SbcsReading
): boolean {
  if (!raw) return false;
  let col = 1;
  for (const ch of line) {
    if (isFullWidth(ch)) {
      col += 2;
      continue;
    }
    const b = raw[col - 1];
    if (b !== undefined && recode(b, alt) !== ch) return true;
    col += 1;
  }
  return false;
}
