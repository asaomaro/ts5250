/**
 * **語送りの欄（FCW 0x8680。DDS の `WRDWRAP`）の語送り**——ACS `PS5250.processWordWrap` の手順を、実機の ACS のコアで測った結果
 * （`scripts/acs-probe/word-wrap.txt`・`20260930-word-wrap` research）と突き合わせて自分の言葉で書き起こしたもの。
 *
 * ## 何をするか
 * 欄に打った・消したあと、**行末にかかった語を次の行へ送る**。送るとき、行の残りを **NUL（空きの桁）で埋める**——空白ではない
 * （ホストが受け取る欄は `aaa bbbb ` + NUL 2 つ ｜ `cccc dddd` の形。READ MDT では途中の NUL が 0x40、ALT では 00）。
 * 欄の値は途中の NUL を実空白と区別して持つ必要があるので、`chars` の空きの桁は `NUL`（U+0000）で表す（core の `fieldValue` は
 * 語送りの欄の途中の NUL を `rawSentinel(0x00)` で返す）。
 *
 * ## 手順（ACS の順どおり）
 * 1. 編集した位置から**語の頭**まで戻る（`wrapStart`）。
 * 2. 語の頭から後ろを**きれいにする**（`cleanNuls`）: 末尾の NUL を捨て、空白の隣の NUL は捨て、語と語の間の NUL の連なりは 1 つに畳む
 *    ——前の語送りが入れた詰め物を外してから組み直すため。
 * 3. 行ごとに**行末の桁が語の途中なら、その語の頭まで NUL を挟んで押し出す**（`spread`）。語が 1 行より長ければ行末で切る（詰め物なし）。
 *    **行末にちょうど収まる語も送られる**（行末の桁が空白でなければ語の途中と数える。実機: `aabbbb cccc` の `cccc` が行末に収まっても次の行）。
 *    最後の行（欄の末尾）は送らない。
 * 4. 組み直した長さが欄に収まるときだけ書き換える（収まらなければ何も変えない）。カーソルより前に入った NUL の数だけカーソルが進む。
 *
 * DBCS の欄（`isDbcsEdit`）・非表示の欄・継続欄には掛けない（ACS は DBCS の欄を対象外にする。ほかは未測定）。
 */

/** 空きの桁（NUL）。`chars` の中で実空白（" "）と区別する */
export const NUL = "\u0000";

const isBlank = (c: string): boolean => c === " " || c === NUL;

export interface WrapResult {
  chars: string[];
  cursor: number;
}

/** 語の頭（ACS `determineWrapStart`）: 位置から左へ、空白か NUL の手前まで */
function wrapStart(list: readonly string[], at: number): number {
  let i = at;
  while (i > 0 && !isBlank(list[i - 1]!)) i--;
  if (i === list.length) i--;
  return i;
}

/**
 * 語の頭から後ろの詰め物をきれいにする（ACS `cleanCopyOfNulls`）。
 * 後ろから見て、末尾の NUL は捨てる。空白の直前（左）に続く NUL は捨てる。空白でない字に挟まれた NUL の連なりは 1 つに畳む。
 */
function cleanNuls(input: readonly string[], from: number): string[] {
  const l = [...input];
  let k = l.length - 1;
  while (k >= from && l[k] === NUL) l.splice(k--, 1);
  let pending = false; // 空白でない字の直前に NUL を捨てた（左の字が空白でなければ 1 つ戻す）
  let afterSpace = false; // 直前に見たのは空白（その左の NUL は詰め物）
  while (k >= from) {
    const c = l[k]!;
    if (c === " ") {
      afterSpace = true;
      pending = false;
    } else if (c === NUL) {
      l.splice(k, 1);
      if (!afterSpace) pending = true;
    } else {
      if (pending) l.splice(k + 1, 0, NUL);
      pending = false;
      afterSpace = false;
    }
    k--;
  }
  return l;
}

/**
 * 語送りを掛けた後の欄を返す。変えないとき（組み直しが欄に収まらない）は `undefined`。
 *
 * @param chars 編集後の欄（長さ = 欄の桁数。空きの桁は `NUL`）
 * @param at 編集した位置（打った桁・消した桁）
 * @param cursor 編集後のカーソル
 * @param rowEnds 行ごとの**最終桁の欄内 index**（昇順。最後は欄の最終桁）
 * @param cols 画面の桁数
 */
export function wordWrap(chars: readonly string[], at: number, cursor: number, rowEnds: readonly number[], cols: number): WrapResult | undefined {
  const len = chars.length;
  if (len === 0) return undefined;
  const from = wrapStart(chars, Math.min(Math.max(at, 0), len));
  const list = cleanNuls(chars, from);
  const lineEnd = (i: number): number => rowEnds.find((e) => e >= i) ?? len - 1;
  let moved = 0; // カーソルより前に入った NUL の数
  for (let i = from; i < len; i++) {
    const end = lineEnd(i);
    if (end > list.length - 1 || end === len - 1) break;
    const floor = Math.max(0, end - cols + 1);
    i = end;
    // 行末から左へ、空白か NUL を探す。1 行ぶん探して無ければ（語が行より長い）行末で切る
    while (!isBlank(list[i]!)) {
      if (i === floor || i === 0) {
        i = end;
        break;
      }
      i--;
    }
    while (i < end) {
      i++;
      list.splice(i, 0, NUL);
      if (i < cursor + moved) moved++;
    }
  }
  if (list.length > len) return undefined;
  while (list.length < len) list.push(NUL);
  return { chars: list, cursor: cursor + moved };
}
