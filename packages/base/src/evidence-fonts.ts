/**
 * **配布 HTML（エビデンス）で選べる等幅フォント。**
 *
 * 画面（`tn5250` の `screen-html.ts`）と帳票（`scs` の `spool-html.ts`）の**両方が使う**。
 * 2 か所に書き写すと、片方だけ候補が増えて「画面 HTML には出るのに帳票 HTML には無い」
 * が起きるので、ここに 1 つだけ置く。
 *
 * **Web フォントは積めない。** 配布 HTML は外部リソースを一切参照しない約束なので、
 * 候補は**読み手の環境にある物を指名するだけ**。どれも最後に標準の並びを足してあるので、
 * 入っていなければ標準へ落ちる。顔ぶれは web-ui の画面フォントに合わせてある。
 */
export interface EvidenceFont {
  /** 選択の保存に使う id（web-ui の `screenFonts` と同じ語彙） */
  id: string;
  /** 切り替えボタンに出す名前 */
  label: string;
  /** CSS の font-family */
  stack: string;
}

/** どの候補にも最後に足す並び（日本語の等幅まで含めた最後の砦） */
export const STD_MONO_STACK =
  `ui-monospace,"SFMono-Regular",Menlo,Consolas,"BIZ UDGothic","MS Gothic",monospace`;

const def = (id: string, label: string, families: string[]): EvidenceFont => ({
  id,
  label,
  stack: `${families.map((f) => `"${f}"`).join(",")},${STD_MONO_STACK}`
});

/**
 * 選べる候補。**先頭が既定**（`標準`）。
 *
 * 版違いでファミリー名が変わるもの（NF / Console など）は、web-ui の
 * `screenFonts.ts` と同じく版名を並べて取りこぼしを防ぐ。
 */
export const EVIDENCE_FONTS: readonly EvidenceFont[] = [
  { id: "system", label: "標準", stack: STD_MONO_STACK },
  def("bizud", "BIZ UDゴシック", ["BIZ UDGothic", "BIZ UDPGothic"]),
  def("msgothic", "MS ゴシック", ["MS Gothic", "Osaka-Mono"]),
  def("hackgen", "白源 HackGen", [
    "HackGen Console NF",
    "HackGen35 Console NF",
    "HackGen Console",
    "HackGen"
  ]),
  def("udev", "UDEV Gothic", ["UDEV Gothic NF", "UDEV Gothic 35NF", "UDEV Gothic"]),
  def("plemol", "PlemolJP", ["PlemolJP Console NF", "PlemolJP Console", "PlemolJP"]),
  def("cica", "Cica", ["Cica"])
];

/** 指定 id の位置（無ければ 0＝標準）。切り替えの初期状態を決めるのに使う */
export function evidenceFontIndex(id: string | undefined): number {
  const i = EVIDENCE_FONTS.findIndex((f) => f.id === id);
  return i < 0 ? 0 : i;
}
