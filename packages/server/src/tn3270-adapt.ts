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
 * WS のキー名 → 3270 の AID。
 *
 * **使えないキーは読み替えずに拒否する**（spec D4）——`PageUp` を `F7` に写すような
 * 気の利かせ方は、ホストのアプリが F7 に別の意味を持たせていたときに取り返しがつかない。
 */
export function toAid3270(key: string): Aid3270 {
  if (key === "Enter") return "enter";
  if (key === "Clear") return "clear";
  const pa = /^PA([123])$/.exec(key);
  if (pa) return `pa${pa[1]}` as Aid3270;
  const pf = /^F([1-9]|1[0-9]|2[0-4])$/.exec(key);
  if (pf) return `pf${pf[1]}` as Aid3270;
  throw new As400Error("PROTOCOL_ERROR", `key ${key} is not available on a 3270 terminal`);
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
