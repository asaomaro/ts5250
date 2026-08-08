/**
 * `textarea` のキャレットの画面位置を測る。
 *
 * ブラウザに「キャレットの座標」を返す API は無い（`Range` は入力欄の中では使えない）。
 * **同じ書式の写しを作って、キャレットまでの文字を流し込み、そこに置いた目印の位置を測る**
 * ——古くから使われている方法で、依存を足さずに済む。
 *
 * 補完の候補一覧をキャレットの下に出すためだけに使う。**ずれても実害が小さい**
 * （一覧の位置が少し動くだけ）ので、書式の再現は「幅と折り返しに効くもの」に絞ってある。
 */

/** 写しに移す書式。**幅と折り返しに効くものだけ**（色や装飾は測定に関係ない） */
const COPIED = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "wordSpacing",
  "tabSize",
  "whiteSpace",
  "overflowWrap",
  "wordBreak"
] as const;

export interface CaretPoint {
  /** 入力欄の左上からの相対位置（スクロール量を引いた後） */
  left: number;
  top: number;
  /** 1 行の高さ。一覧を行の下に置くのに使う */
  height: number;
}

/**
 * キャレット（`selectionEnd`）の位置を、入力欄の左上を原点として返す。
 *
 * @param el 対象の `textarea`
 * @param at 位置を測る文字オフセット。省略時は `selectionEnd`
 */
export function caretPosition(el: HTMLTextAreaElement, at?: number): CaretPoint {
  const index = at ?? el.selectionEnd;
  const style = globalThis.getComputedStyle(el);
  const mirror = document.createElement("div");
  const s = mirror.style;
  // 画面に出さずに測る。`visibility: hidden` では**レイアウトは走る**ので位置が取れる
  s.position = "absolute";
  s.visibility = "hidden";
  s.whiteSpace = "pre-wrap";
  s.overflowWrap = "break-word";
  s.top = "0";
  s.left = "0";
  for (const key of COPIED) s[key] = style[key];
  // 高さは中身なりに伸ばす（`textarea` の固定高を写すと折り返し位置がずれる）
  s.height = "auto";

  mirror.textContent = el.value.slice(0, index);
  // **末尾の改行だけでは高さが増えない**ので、目印の前に 1 文字ぶんの受けを置く
  const marker = document.createElement("span");
  marker.textContent = el.value.slice(index) || ".";
  mirror.appendChild(marker);

  document.body.appendChild(mirror);
  const left = marker.offsetLeft;
  const top = marker.offsetTop;
  const height = Number.parseFloat(style.lineHeight) || marker.offsetHeight || 16;
  mirror.remove();

  return { left: left - el.scrollLeft, top: top - el.scrollTop, height };
}
