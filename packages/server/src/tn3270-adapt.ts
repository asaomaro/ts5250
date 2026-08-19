import { As400Error } from "@ts5250/base";
import type { ScreenSnapshot, Cell, Field, ScreenColor } from "@ts5250/tn5250";
import type { Tn3270Session } from "@ts5250/tn3270";
import type { AidKey as Aid3270 } from "@ts5250/tn3270";
import type { WsKeyField } from "./ws-messages.js";

/**
 * **3270 セッションを Web の口に合わせる薄い層。**
 *
 * `server` と `web-ui` が話す画面型は `@ts5250/tn5250` の `ScreenSnapshot`。
 * 3270 の型は**極めて近い**ので、**ここ 1 か所で変換**して web-ui を無改修のままにする
 * （spec D2）。
 *
 * **変換をここに置く理由**——`tn5250` と `tn3270` は**兄弟パッケージで相互参照禁止**
 * （`dependency-direction.test.ts`）。両方を知ってよいのは上位の `server` だけ。
 */

/** web-ui が受け取れるモデル（spec D3） */
export type Model3270Web = 2 | 5;

/**
 * 3270 の画面を 5250 の `ScreenSnapshot` へ写す。
 *
 * 落とすもの（5250 側に無く、描画にも使われていない）: `background` / `intensified` /
 * `alternate` / `unformatted`。
 * 足すもの: `sessionId`、`Cell.columnSeparator`（5250 の 3270 相当は無いので常に `false`）。
 */
/**
 * 色の写像。**3270 には `default` と `black` があり、5250 には無い**。
 * どちらも「色の指定が無い／地の色」なので、5250 側の既定色 `green` に寄せる
 * （web-ui は `green` を「指定なし」として描いている）。
 */
function toWireColor(c: string): ScreenColor {
  return c === "default" || c === "black" ? "green" : (c as ScreenColor);
}

export function toWireScreen(session: Tn3270Session, sessionId: string): ScreenSnapshot {
  const snap = session.snapshot();
  const rows = snap.rows === 27 ? 27 : 24;
  const cols = snap.cols === 132 ? 132 : 80;
  const cells: Cell[][] = snap.cells.map((row) =>
    row.map((c) => ({
      char: c.char,
      kind: c.kind,
      color: toWireColor(c.color),
      reverse: c.reverse,
      underline: c.underline,
      blink: c.blink,
      columnSeparator: false,
      nonDisplay: c.nonDisplay,
      ...(c.rawByte !== undefined ? { rawByte: c.rawByte } : {})
    }))
  );
  return {
    sessionId,
    rows,
    cols,
    cursor: snap.cursor,
    keyboardLocked: snap.keyboardLocked,
    cells,
    // **長さ 0 の欄は落とす。** 3270 は属性桁が隣接すると中身の無い欄ができるが、
    // 5250 側の消費者は「欄は 1 桁以上ある」前提で書かれている（描画も入力も置き場が無い）。
    // 落とさないと **web-ui が桁を進められず無限ループでタブごと落ちる**（pub400 で踏んだ）。
    // 添字（`index`）は振り直さない——入力欄の指定に使うため、番号は元のまま保つ
    fields: snap.fields
      .filter((f) => f.length > 0)
      .map(
      (f): Field => ({
        index: f.index,
        row: f.row,
        col: f.col,
        length: f.length,
        protected: f.protected,
        numeric: f.numeric,
        hidden: f.hidden,
        mdt: f.modified,
        value: f.value
      })
      )
  };
}

/**
 * 押されたキーを**どう送るか**。
 *
 * - `aid` … その AID をそのまま送る
 * - `functionKey` … **5250 の F キー**として送る（IBM i では `PA1` ＋ `PFn` の 2 往復）
 */
export type Key3270Plan = { kind: "aid"; aid: Aid3270 } | { kind: "functionKey"; n: number };

/**
 * IBM i でだけ割り当てのあるキー。
 *
 * 出典は **IBM i 自身**の「ヘルプ－ 3270 キーボード・マッピング」画面
 * （3270 で繋いで `PF2`）。推測ではない。
 */
const IBMI_ONLY: Readonly<Record<string, Aid3270>> = {
  Attn: "pf9", // アテンション
  SysReq: "pf11", // システム要求
  Help: "pf1", // 5250 ヘルプ・テキスト
  Print: "pf4" // 画面の印刷
};

/**
 * WS のキー名 → 送り方。
 *
 * ## なぜホストの種類で変わるのか
 *
 * **IBM i では 3270 の `PFn` は F キーではない。** `PF3` は「画面の消去」で、
 * F1〜F12 を押すには `PA1` ＋ `PFn` を送る。メインフレーム（z/OS / TK4-）は
 * `PFn` がそのまま Fn。**同じ表を両方に当てると必ずどちらかが壊れる。**
 *
 * ## ページ送りは F7 / F8 ではない
 *
 * IBM i の `PF7` / `PF8` は「前ページ・キー / 次ページ・キー」そのもの。
 * **F7 / F8 として送ってはならない**（`PA1` を前置すると別のキーになる）。
 * メインフレームでも `PF7` / `PF8` が慣行なので、どちらも素の AID を送る。
 */
export function planKey3270(key: string, isIbmI: boolean): Key3270Plan {
  if (key === "Enter") return { kind: "aid", aid: "enter" };
  if (key === "Clear") return { kind: "aid", aid: "clear" };
  // **ページ送りは素の PF7 / PF8**（F7 / F8 とは別物）
  if (key === "PageUp") return { kind: "aid", aid: "pf7" };
  if (key === "PageDown") return { kind: "aid", aid: "pf8" };
  const pa = /^PA([123])$/.exec(key);
  if (pa) return { kind: "aid", aid: `pa${pa[1]}` as Aid3270 };
  const pf = /^F([1-9]|1[0-9]|2[0-4])$/.exec(key);
  if (pf) return { kind: "functionKey", n: Number(pf[1]) };
  const only = IBMI_ONLY[key];
  if (only !== undefined) {
    if (isIbmI) return { kind: "aid", aid: only };
    throw new As400Error(
      "PROTOCOL_ERROR",
      `${key} はこのホスト（メインフレーム）の 3270 には割り当てがありません`
    );
  }
  throw new As400Error("PROTOCOL_ERROR", `${key} は 3270 端末では送れません`);
}

/**
 * 入力欄への書き込み。
 *
 * `field` は**添字**または**行桁**。どちらも今の画面の欄一覧から解決する。
 * 書き込みは **カーソルを欄の先頭へ置いて `type()`**——3270 の `type()` は
 * 欄の種類（素／混在入力／DBCS 欄）を見て日本語を撥ねたり `SO`/`SI` で包んだりするので、
 * こちらで文字を作り分けない。
 */
export function applyFields(session: Tn3270Session, fields: readonly WsKeyField[]): void {
  const snap = session.snapshot();
  for (const f of fields) {
    if (!("value" in f)) {
      // マクロの秘密は 3270 では受けない（マクロ自体が対象外。spec 6）
      throw new As400Error("PROTOCOL_ERROR", "secretRef is not supported on a 3270 session");
    }
    const ref = f.field;
    // **添字は 1 始まり**（`Field.index` の規約。5250 の口と同じ数え方）。
    // 配列の添字として使うと 1 つずれ、TK4- の入力欄に打ったつもりが
    // **隣の保護欄に当たって `FIELD_PROTECTED`** になる（ブラウザ E2E で踏んだ）
    const target =
      typeof ref === "number"
        ? snap.fields.find((x) => x.index === ref)
        : snap.fields.find((x) => x.row === ref.row && x.col === ref.col);
    if (target === undefined) {
      throw new As400Error("FIELD_NOT_FOUND", `no field at ${JSON.stringify(ref)}`);
    }
    if (target.protected) {
      throw new As400Error("FIELD_PROTECTED", `field at (${target.row},${target.col}) is protected`);
    }
    session.setCursor(target.row, target.col);
    session.type(f.value);
  }
}
