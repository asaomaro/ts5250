/**
 * 画面グリッド（--screen-mono）のフォント選択。**推奨一覧＋インストール済みフォント**を扱う。
 *
 * 設定値（`ViewSettings.font`）は 2 種類を受ける:
 *  - 推奨一覧の id（`hackgen` 等）… 版名ちがい（35/NF/Console）を束ねた**スタック**を当てる
 *  - **フォントのファミリー名そのもの**（`Meiryo` 等）… 利用者が入れたフォントを直に指定する
 *
 * 【重要】推奨一覧の判定・適用は**実フォント名**で行う（ラベル「白源 HackGen」等では探さない）。
 * HackGen/PlemolJP/UDEV/Firge などは「35版」「Nerd Font(NF)版」「Console 版」で**ファミリー名が異なる**ため、
 * それぞれの版名を probe（判定）と stack（適用）の両方に網羅して取りこぼしを防ぐ。
 *
 * 【重要】**導入判定は選択の可否を決めない**（助言に留める）。判定は canvas 実測や
 * Local Font Access の許可に左右され、実際には入っているのに未検出になることがある。
 * そこで選択自体は常に許し、当たらなければ CSS が既定スタックへ落ちる形にしてある——
 * 「入れたのに選べない」で手が止まるより、選ばせて見た目で分かるほうがよい。
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

/** 推奨一覧の id（`SCREEN_FONTS` の並び）。 */
export type CuratedFontId =
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

/**
 * 画面フォントの設定値。**推奨一覧の id か、インストール済みフォントのファミリー名**。
 * 文字列型なのは後者を受けるため——一覧に無いフォントも選べる（利用者の要望）。
 */
export type ScreenFontId = string;

/** families の先頭から優先で並べ、stack（CSS 指定）と probe（判定名）を同じ集合で作る。 */
function def(id: CuratedFontId, label: string, families: string[], keywords: string[]): ScreenFontDef {
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

/** 推奨一覧の id か（＝ファミリー名としてではなく id として解決すべきか）。 */
export function isCuratedId(id: string): boolean {
  return SCREEN_FONTS.some((f) => f.id === id);
}

/**
 * 設定値 → `--screen-mono` に入れる値。`system` / 空 / 不正は空文字（＝既定スタックのまま）。
 *
 * 推奨一覧なら版名を束ねたスタック、そうでなければ**ファミリー名そのもの**を前置する。
 * どちらも後ろに既定スタックを残すので、当たらなくても 1:2 のフォールバックは保たれる。
 */
export function screenFontStack(id: string): string {
  const d = SCREEN_FONTS.find((f) => f.id === id);
  if (d) return d.stack ? `${d.stack}, var(--screen-mono-stack)` : "";
  const fam = sanitizeFamily(id);
  if (!fam) return "";
  return `"${fam}", var(--screen-mono-stack)`;
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
  fullName?: string;
  postscriptName?: string;
}

/** インストール済みフォント 1 件（ファミリー単位に畳んだもの）。 */
export interface InstalledFont {
  family: string;
  fit: FontFit;
}

/**
 * Local Font Access API（Chromium 系）で実際に入っているフォントを取る。
 * 非対応・権限拒否・ユーザー操作外では `null`。**呼ぶのは 1 回だけ**——
 * 推奨一覧の導入判定とインストール済み一覧の両方をここから導く
 * （2 回呼ぶと権限プロンプトが二重に出る）。
 */
async function queryLocal(): Promise<LocalFontData[] | null> {
  const q = (globalThis as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts;
  if (typeof q !== "function") return null;
  let fonts: LocalFontData[];
  try {
    fonts = await q();
  } catch {
    return null; // 権限拒否・ユーザー操作外など
  }
  return fonts && fonts.length > 0 ? fonts : null;
}

/**
 * 列挙結果を**ファミリー単位に畳んで**桁揃えを測る。
 * queryLocalFonts はスタイル（Regular/Bold…）ごとに 1 件返すため、そのままだと重複する。
 * 桁揃えは畳んだあとに 1 回だけ測る（数百件でも measureText 数回ずつで済む）。
 */
function toInstalled(fonts: LocalFontData[]): InstalledFont[] {
  const families = new Set<string>();
  for (const f of fonts) {
    const fam = sanitizeFamily(f.family ?? "");
    if (fam) families.add(fam);
  }
  return [...families]
    .sort((a, b) => a.localeCompare(b, "ja"))
    .map((family) => ({ family, fit: measureFontFit(family) }));
}

/**
 * family/fullName/postscriptName に keyword が部分一致する推奨 id を導入済みとする。
 * 版名（35/NF/Console/Nerd）に依存せず確実。
 */
function idsFromLocal(fonts: LocalFontData[]): Set<string> {
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

/** フォント選択肢の材料。`installed` が null なら列挙できない環境（名前の直接入力へ倒す）。 */
export interface FontChoices {
  /** 推奨一覧のうち導入済みと判定できた id（判定は助言。選択は塞がない） */
  installedIds: Set<string>;
  /** インストール済みフォント一覧。null＝Local Font Access が使えない */
  installed: InstalledFont[] | null;
}

/**
 * 選択肢を作る。可能なら Local Font Access（正確・版名非依存・一覧つき）、
 * 無ければ canvas 実測（推奨一覧の導入判定のみ・一覧は出せない）。
 * **ユーザー操作（クリック）内で呼ぶと Local Font Access の許可を得られる。**
 */
export async function loadFontChoices(): Promise<FontChoices> {
  const fonts = await queryLocal();
  if (!fonts) return { installedIds: idsViaCanvas(), installed: null };
  return { installedIds: idsFromLocal(fonts), installed: toInstalled(fonts) };
}

/** 設定値 → 表示名。推奨一覧はラベル、ファミリー名指定はその名前をそのまま。 */
export function screenFontLabel(id: string): string {
  return SCREEN_FONTS.find((f) => f.id === id)?.label ?? id;
}
