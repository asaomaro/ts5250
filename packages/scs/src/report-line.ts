/**
 * **帳票 1 行を「描くための区間」に分ける。** 画面（web-ui の `ReportText`）と
 * 配布 HTML（`spool-html.ts`）が**同じ関数を通る**ようにするための層。
 *
 * 分けているのは 3 つの都合だけで、帳票そのものは属性を持たない（SCS は色も強調も無い）:
 *
 * - **全角**は 2 桁の箱に入れる必要がある（フォントに桁幅を委ねない）
 * - **読みで字が変わる区間**は 2 通りの字を持つ（表示コード切替。カナ ⇄ 英）
 *
 * ここを 1 か所にしておかないと、「画面ではこう見えるのに保存した HTML では違う」が起きる。
 * 桁と文字列の添字は**一致しない**（全角が 1 文字で 2 桁を占める）ので、桁は別に数える。
 *
 * **SO/SI の印はここに入れない。** 印は桁を持たず、`shifts` の桁位置に**重ねて**描く
 * ——文字の流れに挟むと印の有無で桁が動いてしまう（`ShiftMark` の注記）。
 */
import { isFullWidth } from "@ts5250/base";
import { katakanaChar, latinChar } from "@ts5250/ebcdic/katakana";
/** SBCS の読み。カナ（CP290 系）／英（CP1027 系） */
export type SbcsReading = "kana" | "latin";

/** 行を分けた 1 区間 */
export type ReportSeg =
  /** 半角の連なり。`alt` があれば読みで字が変わる（無ければどちらの読みでも同じ） */
  | { kind: "text"; text: string; alt?: string }
  /** 全角 1 文字（2 桁の箱に入れる） */
  | { kind: "wide"; text: string };

/**
 * 描けない字を半角スペースに落とす（ACS と同じ。web-ui の `displayText` と同じ扱い）。
 *
 * **そのまま復号した字にも掛ける。** 帳票の復号コードページにマップの無いバイトを
 * コーデックは U+FFFD で返すので、素通しすると `◆`（U+FFFD の字形）が本文に混ざる
 * ——DSPFMT の帳票で実際に出た（利用者の報告。CCSID 1399 では 256 中 29 バイトが該当）。
 * しかも U+FFFD は**多くのフォントで全角幅**なので、1 桁のはずが 2 桁を占めて行がずれる。
 *
 * EBCDIC の SBCS 表は 256 バイト中 96 バイトを制御文字（C0 / DEL / C1）へ写すので、
 * 読み直した先が制御文字になることもある。そちらも豆腐（□）になるので同じく伏せる。
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
 * @param alt    もう一方の読み。`undefined` なら 1 通りだけ
 */
export function reportLineSegs(
  line: string,
  raw: readonly (number | undefined)[] = [],
  alt?: SbcsReading
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
  for (const raw0 of line) {
    // **そのまま側にも掛ける**（`displayableChar` の注記）。全角の判定より先に通すのは、
    // U+FFFD が全角幅で描かれる環境があり、箱に入れると 2 桁を占めてしまうため。
    const ch = displayableChar(raw0);
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
  for (const raw0 of line) {
    const ch = displayableChar(raw0);
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
