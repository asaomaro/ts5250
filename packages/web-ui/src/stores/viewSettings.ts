import { reactive } from "vue";
import type { ScreenFontId } from "../composables/screenFonts.js";

/**
 * エミュレーター「画面表示」設定。**単一の設定を保存**（localStorage）し、全画面に適用する。
 * メニューで変えた値はそのまま記憶され、新しい画面・再読み込み後も維持される。
 * 対象: SO/SI 表示・表示コード（カナ⇄英）・リンク化・コントロール表現（画面内入力欄の見せ方）・
 *       配色（端末色⇄意味色）・画面の質感（CRT⇄フラット）・フォント。
 */
/** 入力欄の見せ方（画面設定「入力項目設定」）。すべて桁を動かさない手段だけで作る（spec D8）。 */
export type ControlStyle =
  | "plain" | "underline" | "filled" | "box" | "boxRound" | "inset" | "dashed" | "glow";
/**
 * SBCS の表示コード（ACS の表示コード切替）。
 *
 * **切り替えとは「もう一方の表で読み直すこと」**——CCSID 930 の SBCS 部（CP290）と
 * 939 の SBCS 部（CP1027）はカタカナと英小文字の位置が入れ替わった鏡像である。
 * だから「カナ / 英」を絶対値で持ち、ホストの表と同じ向きなら再解釈しない、という形にする。
 * `auto` はホストの表のまま＝**どの CCSID でも今までどおりの見た目**（既定）。
 */
export type KanaView = "auto" | "kana" | "latin";
/** 画面グリッドに渡す実効の表示コード。`host` は再解釈しない（`recodeChar` を通さない） */
export type SbcsView = "host" | "kana" | "latin";

/**
 * 保存値（`KanaView`）とホストの SBCS 表から、実効の表示コードを決める。
 *
 * **ホストの表と同じ向きを選んだら `host` を返す**のが要点——再解釈を通さないので、
 * `rawByte` を持たないセル（DBCS・属性桁・オーダーが書いた文字）でも表示が崩れない。
 */
export function resolveSbcsView(kana: KanaView, hostIsKatakana: boolean): SbcsView {
  if (kana === "auto") return "host";
  if (kana === "kana") return hostIsKatakana ? "host" : "kana";
  return hostIsKatakana ? "latin" : "host";
}

/** 配色: literal=5250 の 7 色をそのまま／semantic=役割ベース（通常=前景・値=アクセント・エラー=赤）へ再マップ */
export type ColorMode = "literal" | "semantic";
/** 画面の質感: crt=フォスファのにじみ＋ベゼル枠／flat=グロー無し・やわらかい影のカード */
export type Surface = "crt" | "flat";
/**
 * ボタンの設定（画面設定「ボタン設定」）。機能キー凡例のボタンと拡張5250 の選択肢に効く。
 * **入力欄の設定（controls）とは別軸**（spec D5）。`none`＝無効で凡例をボタン化しない
 * （拡張5250 の選択肢はホストが宣言した操作部品なので、無効でも現状の意匠で機能を保つ）。
 */
/** ウィンドウ**そのもの**の見せ方（枠・面）。重ねて描くだけで文字・桁・ホスト色には触れない。 */
export type WindowFrame = "none" | "shadow" | "raised" | "outline";
/** ウィンドウの**背景**（窓の外側）の見せ方。スモークのほか、すりガラス・ぼやけを選べる。 */
export type WindowBackdrop = "none" | "smoke" | "frost" | "blur";
/** オプション欄の選択肢の見せ方。none は出さない（既定） */
export type OptHintStyle = "none" | "panel" | "outline" | "crt";

export type ButtonStyle =
  | "none" | "underline" | "filled" | "box" | "pill" | "ghost" | "raised" | "link";
export interface ViewSettings {
  sosi: boolean;
  /** SBCS の表示コード（ACS の表示コード切替）。既定 auto＝ホストの表のまま */
  kana: KanaView;
  linkify: boolean;
  controls: ControlStyle;
  colorMode: ColorMode;
  surface: Surface;
  /** 機能キー凡例・拡張5250 の選択肢の見せ方 */
  buttons: ButtonStyle;
  /** ウィンドウそのもの（枠・面）の見せ方 */
  windowFrame: WindowFrame;
  /** ウィンドウの背景（窓の外側）の見せ方 */
  windowBackdrop: WindowBackdrop;
  /**
   * オプション欄の選択肢の見せ方（`WRKxxx` / PDM 系の一覧で `2=変更 3=コピー …` の凡例から作る）。
   * **推測を含む機能なので既定は none**（勝手に有効化しない。`windowFrame` の既定が none なのと同じ扱い）。
   */
  optHints: OptHintStyle;
  /**
   * `F4` の導線（凡例に `F4=…` がある画面で、フォーカス中の欄から F4 を送れるボタン）。
   *
   * **検出は推測を含まない**（ホストが凡例に書いた事実だけを見る）が、**画面に部品を重ねる**ので
   * 既定は OFF——backlog の「勝手に有効化しない」に従う。
   */
  promptHint: boolean;
  /** 画面グリッドのフォント（screenFonts.ts の id）。いずれも和欧 1:2 の一体フォント。 */
  font: ScreenFontId;
}
export type ViewKey = keyof ViewSettings;
type Key = ViewKey;

/**
 * 設定項目の定義（表示順・選択肢）。**画面設定メニューとキー設定で共有する単一の出どころ**。
 * font はここに含めない（選択肢が環境依存で、順送りに向かないため。メニューのセレクトで扱う）。
 */
export interface ViewItemDef {
  key: Exclude<ViewKey, "font">;
  label: string;
  /** 選択肢が多い行は、メニューでラベルを上・セグメントを下段全幅にする */
  wide?: boolean;
  opts: { value: ViewSettings[Key]; label: string }[];
  /** 同じ `group` を持つ項目は**1 つの畳んだ行にまとめて**表示し、開いたときに
   *  セクションで区切って並べる（例: ウィンドウ設定＝ウィンドウ／背景）。
   *  設定自体は項目ごとに独立しており、キー設定の順送りも項目ごとに効く。 */
  group?: string;
  /** そのグループの見出し（グループ先頭の項目にだけ書く） */
  groupLabel?: string;
  /** true なら**畳んだ行**にする。ラベルの右に「開く / 閉じる」を置き、開いたときだけ
   *  デザイン候補を並べる（選択肢が多く、常時出すとメニューが縦に伸びるため）。
   *  キー設定の順送りは畳んでいても opts 全体を一巡する。 */
  expandable?: boolean;
}
export const VIEW_ITEMS: ViewItemDef[] = [
  { key: "sosi", label: "SO/SI 表示", opts: [{ value: false, label: "非表示" }, { value: true, label: "表示" }] },
  {
    key: "kana",
    label: "表示コード",
    // 「自動」はホストの表のまま。カナ系ホスト（930/5026）では「カナ」が、
    // 英小文字系（939/1399/5035）では「英」が自動と同じ結果になる（resolveSbcsView）。
    opts: [
      { value: "auto", label: "自動" },
      { value: "kana", label: "カナ" },
      { value: "latin", label: "英" },
    ],
  },
  { key: "linkify", label: "リンク化", opts: [{ value: true, label: "ON" }, { value: false, label: "OFF" }] },
  // 見た目の候補が無いので `linkify` と同じ 2 択（backlog:「全部にデザイン候補を作らない」）
  { key: "promptHint", label: "F4 の導線", opts: [{ value: true, label: "ON" }, { value: false, label: "OFF" }] },
  {
    key: "optHints",
    label: "オプション選択肢",
    wide: true,
    expandable: true,
    // 画面に重ねる部品なので、CRT の上での馴染み方を選べるようにする（buttons と同じ考え方）
    opts: [
      { value: "none", label: "無効" },
      { value: "panel", label: "パネル" },
      { value: "outline", label: "枠" },
      { value: "crt", label: "端末調" },
    ],
  },
  {
    key: "controls",
    label: "入力項目設定",
    wide: true,
    expandable: true,
    opts: [
      { value: "plain", label: "プレーン" },
      { value: "underline", label: "下線" },
      { value: "filled", label: "塗り" },
      { value: "box", label: "枠" },
      { value: "boxRound", label: "丸枠" },
      { value: "inset", label: "くぼみ" },
      { value: "dashed", label: "破線" },
      { value: "glow", label: "発光" },
    ],
  },
  {
    key: "buttons",
    label: "ボタン設定",
    wide: true,
    expandable: true,
    opts: [
      { value: "none", label: "無効" },
      { value: "underline", label: "下線" },
      { value: "filled", label: "塗り" },
      { value: "box", label: "枠" },
      { value: "pill", label: "ピル" },
      { value: "ghost", label: "ゴースト" },
      { value: "raised", label: "立体" },
      { value: "link", label: "リンク風" },
    ],
  },
  {
    key: "windowFrame",
    label: "ウィンドウ",
    group: "window",
    groupLabel: "ウィンドウ設定",
    expandable: true,
    opts: [
      { value: "none", label: "無効" },
      { value: "shadow", label: "影" },
      { value: "raised", label: "浮き出し" },
      { value: "outline", label: "枠強調" },
    ],
  },
  {
    key: "windowBackdrop",
    label: "背景",
    group: "window",
    expandable: true,
    opts: [
      { value: "none", label: "無効" },
      { value: "smoke", label: "スモーク" },
      { value: "frost", label: "すりガラス" },
      { value: "blur", label: "ぼやけ" },
    ],
  },
  { key: "colorMode", label: "配色", opts: [{ value: "literal", label: "端末色" }, { value: "semantic", label: "意味色" }] },
  { key: "surface", label: "画面の質感", opts: [{ value: "flat", label: "フラット" }, { value: "crt", label: "CRT" }] },
];

/** 項目定義を引く（不明キーは undefined）。 */
export function viewItem(key: string): ViewItemDef | undefined {
  return VIEW_ITEMS.find((i) => i.key === key);
}

// 単層の保存キー（旧二層の as400.view.defaults とは分ける＝新しい初期値をクリーンに適用）。
const STORAGE_KEY = "as400.view.settings";
const FALLBACK: ViewSettings = {
  sosi: false, // 非表示
  kana: "auto", // ホストの表のまま
  linkify: true,
  optHints: "none", // 推測を含むので既定は出さない
  promptHint: false, // 画面に部品を重ねるので、利用者が選んでから出す
  controls: "plain",
  colorMode: "literal", // 端末色
  surface: "flat",
  buttons: "none",
  windowFrame: "none",
  windowBackdrop: "none",
  font: "system",
};

const state = reactive({ settings: { ...FALLBACK } as ViewSettings });

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  } catch {
    /* localStorage 不可でも動作は継続 */
  }
}

/** 保存済みの旧値を現行の値へ読み替える。`rich` は「枠」の意匠そのままなので `box` に対応する
 *  （spec D8「旧値の移行」）。利用者から見た変化は無い。 */
function migrate(v: ViewSettings): ViewSettings {
  const out = { ...v };
  // 旧 `kana: boolean`（2 値）を 3 値へ。**利用者から見た挙動は変えない**——
  // 旧 false（英）は再解釈しない挙動だったので `auto`、旧 true（カナ）は `kana` に対応する
  // （カナ系ホストでは resolveSbcsView が `host` に倒すので、こちらも従来どおり無変化）。
  if (typeof (out.kana as unknown) === "boolean") {
    out.kana = (out.kana as unknown as boolean) ? "kana" : "auto";
  }
  if ((out.controls as string) === "rich") out.controls = "box";
  if ((out.buttons as string) === "rich") out.buttons = "box";
  // 旧 `windowView`（ウィンドウと背景が 1 項目だった頃）を 2 項目へ分解する
  const legacy = (v as unknown as { windowView?: string }).windowView;
  if (legacy) {
    const map: Record<string, [WindowFrame, WindowBackdrop]> = {
      none: ["none", "none"],
      shadow: ["shadow", "none"],
      smoke: ["none", "smoke"],
      smokeShadow: ["shadow", "smoke"],
      raised: ["raised", "none"],
      outline: ["outline", "none"],
    };
    const m = map[legacy];
    if (m) {
      out.windowFrame = m[0];
      out.windowBackdrop = m[1];
    }
  }
  return out;
}

export const viewSettings = {
  /** 現在の設定（保存済み・全画面共通） */
  get settings(): ViewSettings {
    return state.settings;
  },
  /** 各画面（ペイン）に渡す実効設定。いまは全画面共通なので保存済み設定をそのまま返す。 */
  effective(_sessionId?: string): ViewSettings {
    return state.settings;
  },
  /** 1 項目を変更して即保存（全画面に反映・再読み込み後も維持）。 */
  set<K extends Key>(key: K, value: ViewSettings[K]): void {
    state.settings = { ...state.settings, [key]: value };
    persist();
  },
  /**
   * 項目を次の選択肢へ**順送り**（末尾なら先頭へ戻る）。キー設定からの切替に使う。
   * 通知用に「項目名」と「切り替わった後の値のラベル」を返す（不明キーは undefined）。
   */
  cycle(key: string): { label: string; valueLabel: string } | undefined {
    const item = viewItem(key);
    if (!item) return undefined;
    const cur = state.settings[item.key];
    const i = item.opts.findIndex((o) => o.value === cur);
    const next = item.opts[(i + 1) % item.opts.length]!; // 見つからない(-1)ときは先頭へ
    this.set(item.key, next.value as never);
    return { label: item.label, valueLabel: next.label };
  },
};

/** 起動時に呼ぶ: localStorage から設定を読み込む。 */
export function initViewSettings(): void {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    // 保存値が無ければ**既定へ戻す**（何もしないと前の状態が残る）。起動時は元から既定なので
    // 実挙動は変わらないが、「読み込み or 既定」を保証しておく方が再初期化に強い。
    state.settings = raw ? migrate({ ...FALLBACK, ...(JSON.parse(raw) as Partial<ViewSettings>) }) : { ...FALLBACK };
  } catch {
    /* 壊れていれば既定のまま */
  }
}
