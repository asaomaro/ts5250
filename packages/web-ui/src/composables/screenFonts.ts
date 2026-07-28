/**
 * 画面グリッド（--screen-mono）のフォント選択。**インストール済みフォントから選ぶ**。
 *
 * 設定値（`ViewSettings.font`）は 2 種類を受ける:
 *  - **フォントのファミリー名そのもの**（`Meiryo` 等）… 一覧から選ぶ／名前で指定する現行の形
 *  - 旧「推奨一覧」の id（`hackgen` 等）… **過去の保存値との互換のためだけ**に残す。
 *    版名ちがい（35/NF/Console）を束ねたスタックへ解決する（`LEGACY_FONTS`）
 *
 * 選択肢を一覧に固定するのはやめた（利用者の要望）。導入判定で選択を塞ぐこともしない——
 * 判定は canvas 実測や Local Font Access の許可に左右され、実際には入っているのに未検出に
 * なることがある。当たらなければ CSS が既定スタックへ落ちるので、外しても桁は崩れない。
 */
interface LegacyFontDef {
  id: string;
  label: string;
  /** --screen-mono に前置する CSS フォント指定（版名を網羅）。system は空（既定スタックのまま）。 */
  stack: string;
}

/**
 * 画面フォントの設定値。**インストール済みフォントのファミリー名**（旧保存値は下の id）。
 */
export type ScreenFontId = string;

/** families の先頭から優先で並べてスタックにする。 */
function def(id: string, label: string, families: string[]): LegacyFontDef {
  return { id, label, stack: families.map((f) => `"${f}"`).join(", ") };
}

/**
 * **旧「推奨」一覧。選択肢としては出さず、過去に保存された設定値を解決するためだけに使う。**
 *
 * ラベルではなく実フォント名で当てる。HackGen/PlemolJP/UDEV/Firge などは
 * 「35版」「Nerd Font(NF)版」「Console 版」で**ファミリー名が異なる**ため、
 * 版名を網羅したスタックにして取りこぼしを防いでいる。
 */
const LEGACY_FONTS: LegacyFontDef[] = [
  { id: "system", label: "標準（自動）", stack: "" },
  // HackGen（白源）: 無印/35、Console、NF(Nerd Fonts)、旧 Nerd(HackGenNerd) の各版
  def("hackgen", "白源 HackGen", [
    "HackGen Console NF", "HackGen35 Console NF",
    "HackGenNerd Console", "HackGen35Nerd Console",
    "HackGen Console", "HackGen35 Console",
    "HackGen", "HackGen35",
    "HackGenNerd", "HackGen35Nerd",
  ]),
  def("udev", "UDEV Gothic", [
    "UDEV Gothic NF", "UDEV Gothic 35NF",
    "UDEV Gothic", "UDEV Gothic 35",
    "UDEV Gothic JPDOC", "UDEV Gothic 35JPDOC",
  ]),
  def("plemol", "PlemolJP", [
    "PlemolJP Console NF", "PlemolJP35 Console NF",
    "PlemolJP Console", "PlemolJP35 Console",
    "PlemolJP", "PlemolJP35",
    "PlemolJP HS", "PlemolJP35 HS",
  ]),
  def("cica", "Cica", ["Cica"]),
  def("firge", "Firge", [
    "FirgeNerd Console", "Firge35Nerd Console",
    "Firge Console", "Firge35 Console",
    "Firge", "Firge35",
    "FirgeNerd", "Firge35Nerd",
  ]),
  def("sarasa", "Sarasa", [
    "Sarasa Term J", "Sarasa Mono J", "Sarasa Fixed J",
    "Sarasa Term CL", "Sarasa Mono CL",
    "Sarasa Gothic J",
  ]),
  def("bizud", "BIZ UDゴシック", ["BIZ UDGothic", "BIZ UDゴシック"]),
  def("osaka", "Osaka-Mono", ["Osaka-Mono", "OsakaMono", "Osaka−等幅"]),
  def("noto", "Noto Sans Mono CJK JP", ["Noto Sans Mono CJK JP", "Noto Sans Mono CJK JP Regular"]),
  def("migu", "Migu 1M", ["Migu 1M"]),
  def("msgothic", "ＭＳ ゴシック", ["MS Gothic", "ＭＳ ゴシック", "MS ゴシック"]),
];

/** 「標準（自動）」＝既定スタックのまま。セレクトの先頭に置く唯一の固定項目。 */
export const SYSTEM_FONT_ID = "system";
export const SYSTEM_FONT_LABEL = "標準（自動）";

/**
 * ファミリー名を CSS へ入れられる形に均す。
 *
 * **設定値は localStorage 由来＝書き換えられうる**うえ、`--screen-mono` はインライン style へ
 * 流し込むので、引用符・波括弧・セミコロン等をそのまま通すと別プロパティを注入できてしまう。
 * CSS の識別子として意味を持つ記号を落とし、長さも切る（フォント名に必要な文字は残る）。
 */
export function sanitizeFamily(name: string): string {
  return name
    .replace(/["'\\;{}()<>:/*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}

/** 旧「推奨」一覧の id か（＝ファミリー名としてではなく id として解決すべきか）。 */
export function isLegacyId(id: string): boolean {
  return LEGACY_FONTS.some((f) => f.id === id);
}

/**
 * 設定値 → `--screen-mono` に入れる値。`system` / 空 / 不正は空文字（＝既定スタックのまま）。
 *
 * 旧 id なら版名を束ねたスタック、そうでなければ**ファミリー名そのもの**を前置する。
 * どちらも後ろに既定スタックを残すので、当たらなくても 1:2 のフォールバックは保たれる。
 */
export function screenFontStack(id: string): string {
  const d = LEGACY_FONTS.find((f) => f.id === id);
  if (d) return d.stack ? `${d.stack}, var(--screen-mono-stack)` : "";
  const fam = sanitizeFamily(id);
  if (!fam) return "";
  return `"${fam}", var(--screen-mono-stack)`;
}

/**
 * 桁が揃うフォントか（canvas 実測）。
 *
 * エミュレーターの桁位置は `ch` 単位で、全角をちょうど 2ch と仮定して重ねる（ScreenGrid）。
 * よって必要なのは 2 つだけ——**半角どうしが同じ幅**（等幅）で、**全角が半角のちょうど 2 倍**。
 * 比例フォントや、和文が 1:2 になっていない等幅は選べても桁がずれるので、一覧で分けて示す。
 */
export interface FontFit {
  /** 半角どうしが同じ幅 */
  monospaced: boolean;
  /** 全角が半角の 2 倍 */
  doubleWidth: boolean;
}

/** 桁が揃う＝等幅かつ和欧 1:2。 */
export function fitsGrid(fit: FontFit): boolean {
  return fit.monospaced && fit.doubleWidth;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
function ctx2d(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx;
  measureCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  return measureCtx;
}

/**
 * ファミリーの桁揃えを実測する。測定不能（canvas が無い等）は「揃う」扱いにして、
 * **判定できないことを理由に選択肢を減らさない**（判定は助言でしかない）。
 *
 * 比較は 1 文字ずつ——`measureText` は文字送り（advance）の合計を返すので、
 * 「あ」1 文字と「a」1 文字の幅比がそのまま桁比になる。
 */
export function measureFontFit(family: string): FontFit {
  const ctx = ctx2d();
  if (!ctx) return { monospaced: true, doubleWidth: true };
  const fam = sanitizeFamily(family);
  if (!fam) return { monospaced: true, doubleWidth: true };
  // フォールバックに monospace を置くと、未導入時も等幅として測れてしまう。
  // ここでは「入っている前提のファミリー」を測るので素直に指定する。
  ctx.font = `72px "${fam}"`;
  const w = (s: string): number => ctx.measureText(s).width;
  const half = w("i");
  const wide = w("あ");
  if (half <= 0) return { monospaced: true, doubleWidth: true };
  // 端数は丸め誤差ぶんだけ許す（0.5px）。72px 基準なので実害のあるずれは必ず超える
  return {
    monospaced: Math.abs(w("W") - half) < 0.5 && Math.abs(w("l") - half) < 0.5,
    doubleWidth: Math.abs(wide - half * 2) < 0.5
  };
}

interface LocalFontData {
  family?: string;
}

/** インストール済みフォント 1 件（ファミリー単位に畳んだもの）。 */
export interface InstalledFont {
  family: string;
  fit: FontFit;
}

/**
 * **実際にインストールされているフォントを列挙する**（Local Font Access。Chromium 系のみ）。
 *
 * 非対応ブラウザ・権限拒否・ユーザー操作外では `null`。呼ぶ側はそのとき
 * 「名前を直接入力」の経路へ倒す（一覧を出せないだけで、指定はできる）。
 * **ユーザー操作（クリック）内で呼ぶと許可を得られる。**
 *
 * queryLocalFonts はスタイル（Regular/Bold…）ごとに 1 件返すので**ファミリー単位に畳む**。
 * 桁揃えは畳んだあとに 1 回だけ測る（数百件でも measureText 数回ずつで済む）。
 */
export async function listInstalledFonts(): Promise<InstalledFont[] | null> {
  const q = (globalThis as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts;
  if (typeof q !== "function") return null;
  let fonts: LocalFontData[];
  try {
    fonts = await q();
  } catch {
    return null; // 権限拒否・ユーザー操作外など
  }
  if (!fonts || fonts.length === 0) return null;
  const families = new Set<string>();
  for (const f of fonts) {
    const fam = sanitizeFamily(f.family ?? "");
    if (fam) families.add(fam);
  }
  return [...families]
    .sort((a, b) => a.localeCompare(b, "ja"))
    .map((family) => ({ family, fit: measureFontFit(family) }));
}

/** 設定値 → 表示名。旧 id はそのラベル、ファミリー名指定はその名前をそのまま。 */
export function screenFontLabel(id: string): string {
  return LEGACY_FONTS.find((f) => f.id === id)?.label ?? id;
}
