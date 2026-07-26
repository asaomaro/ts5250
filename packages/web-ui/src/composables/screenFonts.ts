/**
 * 画面グリッド（--screen-mono）に選べる日本語対応等幅フォントの一覧と、導入判定。
 *
 * ここに並ぶのは styles.css の `--screen-mono-stack` に載っている全フォント（和欧 1:2 の一体フォント）。
 * 画面設定の「フォント」はこの中から選び、選んだフォントを既定スタックの前に足す（未導入なら
 * 既定スタックへ安全にフォールバックし、桁揃え=1:2 は常に保たれる）。
 *
 * 【重要】判定・適用は**実フォント名**で行う（メニューのラベル「白源 HackGen」等では探さない）。
 * HackGen/PlemolJP/UDEV/Firge などは「35版」「Nerd Font(NF)版」「Console 版」で**ファミリー名が異なる**ため、
 * それぞれの版名を probe（判定）と stack（適用）の両方に網羅して取りこぼしを防ぐ。
 */
export interface ScreenFontDef {
  id: string;
  label: string;
  /** --screen-mono に前置する CSS フォント指定（バリアント込み）。system は空（既定スタックのまま）。 */
  stack: string;
  /** canvas 実測判定に試すファミリー名。どれか描画に効けば「導入済み」。 */
  probe: string[];
  /** Local Font Access で実在フォント名（family/fullName/postscript）に**部分一致**させるトークン（小文字）。
   *  版名（35/NF/Console/Nerd）に依存せず拾えるよう、共通キーワードにする。 */
  keywords: string[];
}

export type ScreenFontId =
  | "system"
  | "hackgen"
  | "udev"
  | "plemol"
  | "cica"
  | "firge"
  | "sarasa"
  | "bizud"
  | "as400"
  | "noto"
  | "migu"
  | "msgothic";

/** families の先頭から優先で並べ、stack（CSS 指定）と probe（判定名）を同じ集合で作る。 */
function def(id: ScreenFontId, label: string, families: string[], keywords: string[]): ScreenFontDef {
  return { id, label, stack: families.map((f) => `"${f}"`).join(", "), probe: families, keywords };
}

export const SCREEN_FONTS: ScreenFontDef[] = [
  { id: "system", label: "標準（自動）", stack: "", probe: [], keywords: [] },
  // HackGen（白源）: 無印/35、Console、NF(Nerd Fonts)、旧 Nerd(HackGenNerd) の各版
  def("hackgen", "白源 HackGen", [
    "HackGen Console NF", "HackGen35 Console NF",
    "HackGenNerd Console", "HackGen35Nerd Console",
    "HackGen Console", "HackGen35 Console",
    "HackGen", "HackGen35",
    "HackGenNerd", "HackGen35Nerd",
  ], ["hackgen"]),
  def("udev", "UDEV Gothic", [
    "UDEV Gothic NF", "UDEV Gothic 35NF",
    "UDEV Gothic", "UDEV Gothic 35",
    "UDEV Gothic JPDOC", "UDEV Gothic 35JPDOC",
  ], ["udev gothic", "udevgothic"]),
  def("plemol", "PlemolJP", [
    "PlemolJP Console NF", "PlemolJP35 Console NF",
    "PlemolJP Console", "PlemolJP35 Console",
    "PlemolJP", "PlemolJP35",
    "PlemolJP HS", "PlemolJP35 HS",
  ], ["plemol"]),
  def("cica", "Cica", ["Cica"], ["cica"]),
  def("firge", "Firge", [
    "FirgeNerd Console", "Firge35Nerd Console",
    "Firge Console", "Firge35 Console",
    "Firge", "Firge35",
    "FirgeNerd", "Firge35Nerd",
  ], ["firge"]),
  def("sarasa", "Sarasa", [
    "Sarasa Term J", "Sarasa Mono J", "Sarasa Fixed J",
    "Sarasa Term CL", "Sarasa Mono CL",
    "Sarasa Gothic J",
  ], ["sarasa"]),
  def("bizud", "BIZ UDゴシック", ["BIZ UDGothic", "BIZ UDゴシック"], ["biz udgothic", "biz udゴシック", "bizudgothic"]),
  def("osaka", "Osaka-Mono", ["Osaka-Mono", "OsakaMono", "Osaka−等幅"], ["as400-mono", "osakamono", "as400－等幅", "as400−等幅"]),
  def("noto", "Noto Sans Mono CJK JP", ["Noto Sans Mono CJK JP", "Noto Sans Mono CJK JP Regular"], ["noto sans mono cjk jp", "notosansmonocjkjp"]),
  def("migu", "Migu 1M", ["Migu 1M"], ["migu 1m", "migu1m"]),
  def("msgothic", "ＭＳ ゴシック", ["MS Gothic", "ＭＳ ゴシック", "MS ゴシック"], ["ms gothic", "msgothic", "ｍｓ ゴシック", "ms ゴシック"]),
];

/** id → --screen-mono に入れる値。system / 不明は空文字（＝既定スタックのまま、上書きしない）。
 *  選んだフォントの後ろに既定スタックを残し、未導入時も 1:2 のフォールバックを保証する。 */
export function screenFontStack(id: string): string {
  const d = SCREEN_FONTS.find((f) => f.id === id);
  if (!d || !d.stack) return "";
  return `${d.stack}, var(--screen-mono-stack)`;
}

/**
 * フォント導入判定器を作る（canvas の実測幅で判定）。
 *
 * `"Family", <generic>` の実測幅が `<generic>` 単体と違えば Family が効いている＝導入済み。
 * **等幅フォントどうしは幅が同じ**で見分けられないため、比較基準に比例フォント(sans-serif/serif)を
 * 含め、かつテスト文字列にラテンを混ぜる（比例 vs 等幅で幅が必ず変わる）。未導入なら generic へ
 * フォールバックして幅が一致する＝誤検出しない。
 */
export function makeFontDetector(): (family: string) => boolean {
  if (typeof document === "undefined") return () => true;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => true;
  const test = "WWMMiilll mmoo亜あアｱ0O1l|xX";
  const size = "72px";
  const bases = ["monospace", "sans-serif", "serif"];
  const baseW: Record<string, number> = {};
  for (const b of bases) {
    ctx.font = `${size} ${b}`;
    baseW[b] = ctx.measureText(test).width;
  }
  return (family) =>
    bases.some((b) => {
      ctx.font = `${size} "${family}", ${b}`;
      return Math.abs(ctx.measureText(test).width - baseW[b]!) > 0.5;
    });
}

/** その id が導入済みか（system は常に true）。probe のどれか 1 つでも効けば導入。 */
export function isScreenFontInstalled(id: string, detect: (f: string) => boolean): boolean {
  const d = SCREEN_FONTS.find((f) => f.id === id);
  if (!d) return false;
  if (d.id === "system") return true;
  return d.probe.some((p) => detect(p));
}

interface LocalFontData {
  family?: string;
  fullName?: string;
  postscriptName?: string;
}

/**
 * Local Font Access API（Chromium 系）で**実際に入っているフォントを列挙**し、
 * family/fullName/postscriptName に keyword が部分一致する id を導入済みとする。
 * 版名（35/NF/Console/Nerd）に依存せず確実。非対応・権限拒否・ユーザー操作外では null（→ canvas へ）。
 */
async function idsViaLocalFonts(): Promise<Set<string> | null> {
  const q = (globalThis as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts;
  if (typeof q !== "function") return null;
  let fonts: LocalFontData[];
  try {
    fonts = await q();
  } catch {
    return null; // 権限拒否・ユーザー操作外など
  }
  if (!fonts || fonts.length === 0) return null;
  const hay = fonts.map((f) =>
    `${f.family ?? ""}\n${f.fullName ?? ""}\n${f.postscriptName ?? ""}`.toLowerCase()
  );
  const ids = new Set<string>(["system"]);
  for (const d of SCREEN_FONTS) {
    if (d.id === "system") continue;
    if (hay.some((h) => d.keywords.some((k) => h.includes(k)))) ids.add(d.id);
  }
  return ids;
}

/** canvas 実測でフォールバック判定。 */
function idsViaCanvas(): Set<string> {
  const detect = makeFontDetector();
  const ids = new Set<string>(["system"]);
  for (const d of SCREEN_FONTS) {
    if (d.id === "system") continue;
    if (d.probe.some((p) => detect(p))) ids.add(d.id);
  }
  return ids;
}

/**
 * 導入済みフォント id の集合。可能なら Local Font Access（正確・版名非依存）、
 * 無ければ canvas 実測（近似）。**ユーザー操作（クリック）内で呼ぶと Local Font Access の許可を得られる。**
 */
export async function detectInstalledFontIds(): Promise<Set<string>> {
  return (await idsViaLocalFonts()) ?? idsViaCanvas();
}

/** id → 表示名（見つからなければ id をそのまま）。 */
export function screenFontLabel(id: string): string {
  return SCREEN_FONTS.find((f) => f.id === id)?.label ?? id;
}
