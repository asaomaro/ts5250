/**
 * 機能キー凡例（`F3=終了` 等）の検出。
 *
 * ホストは凡例を**単なるテキスト**として送ってくる（拡張5250 の画面でも同じ。research F4）。
 * 利用者から見れば「押せる操作」なので、テキストから機械的に拾ってボタンにする。
 *
 * 【この実装が桁（column）を基準にする理由 — spec D1】
 * DBCS があると**文字列インデックスと桁がずれる**（実測: 同じ行で `F12` が文字列 37 桁 43）。
 * 桁がずれるとボタンの位置・幅が実際の文字とずれるため、`cells`（1 セル = 1 桁、DBCS は
 * lead + tail の 2 セル）を基準に「表示文字列」と「文字列 index → 桁」の対応を同時に作る。
 */
import type { AidKey, Cell, ScreenSnapshot } from "@ts5250/tn5250";

/** 検出した凡例 1 件。座標は 1 始まりの桁。 */
export interface FkeySpan {
  row: number;
  /** "F" が始まる桁 */
  col: number;
  /** 凡例全体（"F3= 終了"）が占める桁数 */
  width: number;
  key: AidKey;
  /** ラベル（前後空白・末尾の罫線を除去済み） */
  label: string;
}

/** 窓の**内側**（1 始まり・閉区間）。窓が無ければ null。 */
export interface WindowRect {
  row1: number;
  row2: number;
  col1: number;
  col2: number;
}

/** 横罫（窓の上下端）。IBM i の既定ヘルプ窓は `.` を使う（research F8 で実測）。 */
const BORDER_H = new Set([".", "-", "─", "━", "═", "_", "＿"]);
/** 縦罫（窓の左右端）。同上、既定は `:`。 */
const BORDER_V = new Set([":", "：", "|", "｜", "│", "┃", "║"]);
/** ラベル末尾に食い込む罫線・区切り（除去する） */
const TRAILING_BORDER = /[.:：|｜│┃║─━═┌┐└┘├┤┬┴┼\s]+$/u;
/** 窓の上下端とみなす横罫の最小長（桁）。見出しの点線 `. . . .` は連続しないので拾わない。 */
const MIN_BORDER_RUN = 8;
/**
 * 反転枠の上下端とみなす反転の最小長（桁）。
 * `MIN_BORDER_RUN` と同じ値だが**共有しない**——将来どちらかだけ調整したくなったときに、
 * 片方を触って両方動くのを避ける。
 */
const MIN_REVERSE_FRAME = 8;

/** `F<n>=` の開始位置。直前が英数字なら凡例ではない（`REF3=` `XF1=` を弾く）。 */
const LEGEND_RE = /(?<![A-Za-z0-9])F(\d{1,2})\s*=\s*/g;

/** セルの表示文字を取り出す関数。呼び出し側（ScreenGrid）が SO/SI マーク・カナ表示の
 *  設定を反映した文字を返せるようにする（設定と検出結果を食い違わせないため）。 */
export type CharOf = (cell: Cell) => string;

const defaultCharOf: CharOf = (c) => (c.char === "" ? " " : c.char);

/** 1 行の「表示文字列」と「文字列 index → 桁(1 始まり)」の対応。DBCS の tail は文字を持たない。 */
interface RowText {
  text: string;
  /** colOf[i] = text[i] が始まる桁 */
  colOf: number[];
  /** widthOf[i] = text[i] が占める桁数（DBCS なら 2） */
  widthOf: number[];
}

/** 行を桁空間のモデルへ変換する（spec D1）。 */
export function rowText(cells: readonly Cell[], cols: number, charOf: CharOf = defaultCharOf): RowText {
  let text = "";
  const colOf: number[] = [];
  const widthOf: number[] = [];
  for (let c = 0; c < cols; c++) {
    const cell = cells[c];
    if (!cell) continue;
    // tail は lead 側が 2 桁ぶんを担うので文字を持たない（持たせると桁と文字数が合わなくなる）
    if (cell.kind === "dbcs-tail") {
      if (widthOf.length > 0) widthOf[widthOf.length - 1] = 2;
      continue;
    }
    text += charOf(cell);
    colOf.push(c + 1);
    widthOf.push(1);
  }
  return { text, colOf, widthOf };
}

/** 行から長さ MIN_BORDER_RUN 以上の横罫の連なりを拾う（桁は 1 始まりの閉区間）。 */
function horizontalRuns(rt: RowText): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let i = 0;
  while (i < rt.text.length) {
    if (!BORDER_H.has(rt.text[i]!)) {
      i++;
      continue;
    }
    let j = i;
    while (j < rt.text.length && BORDER_H.has(rt.text[j]!)) j++;
    if (j - i >= MIN_BORDER_RUN) out.push({ from: rt.colOf[i]!, to: rt.colOf[j - 1]! });
    i = j;
  }
  return out;
}

/** 行から「反転が途切れず続く区間」を拾う（桁は 1 始まりの閉区間）。 */
function reverseRuns(cells: readonly Cell[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let i = 0;
  while (i < cells.length) {
    if (!cells[i]!.reverse) {
      i++;
      continue;
    }
    let j = i;
    while (j < cells.length && cells[j]!.reverse) j++;
    out.push({ from: i + 1, to: j });
    i = j;
  }
  return out;
}

/**
 * **反転表示が途切れなく閉じた矩形**を作っていればその外周を返す。
 *
 * ホストの ATNPGM の窓（Attn の「コマンド入力」）は枠を反転表示の空白セルで描き、罫線文字を
 * 1 つも使わないため `horizontalRuns` では拾えない。判定できないと、窓が出ている間も
 * **背面の F キー凡例がボタンとして残り**、押すと窓側の文脈で解釈されてラベルと食い違う。
 *
 * 反転は見出し行・メッセージ行・選択行の強調にも使われるので、**閉じていることを厳しく要求する**:
 *
 * 1. 上端: 途切れない反転の連なり（`MIN_REVERSE_FRAME` 桁以上）
 * 2. 下端: 2 行以上下に、**同じ桁範囲**の途切れない反転の連なり
 * 3. 側面: その間の**すべての行**で左右端の桁が両方とも反転
 * 4. **内側: 反転でないセルが 1 つ以上ある（＝中が空いている）**
 *
 * 「上下 2 本の反転バー」だけでは 3 を満たさないので弾ける。
 * **4 が要るのは、1〜3 が「全部が反転した塗り潰しブロック」でも成立してしまうから**——
 * 全面反転なら上端も下端も途切れず、側面の 2 桁も当然反転している。枠として本質的なのは
 * 中が空いていることで、見出しや選択行の強調が数行続くと実際に誤判定した（実機報告）。
 *
 * 4 は「**内側のどこかに** 1 つでも非反転があれば可」という緩い条件にしてある。
 * 窓の中に**全幅の反転強調行**（選択中の行）が入るのは普通なので、
 * 「内側の全行に非反転を要求する」と本物の窓を弾いてしまう。
 *
 * 上下端を完全一致にしているのは、
 * 反転枠は属性そのもので描かれるため桁がずれる理由が無いから（実機 SR-OSAKA で確認）。
 * 罫線経路が重なり率で判定しているのは端の記号（`:`）の有無でずれるからで、事情が違う。
 *
 * **矩形は削らずそのまま返す。** 上下端の行は枠ではなく中身（タイトル・F キー凡例が載る）で、
 * 削ると凡例が落ちる（拡張5250 の窓で削らないのと同じ理由）。
 */
function detectReverseFrame(snap: ScreenSnapshot): WindowRect | null {
  const runs = snap.cells.map((cells) => reverseRuns(cells));
  if (!runs.some((r) => r.length > 0)) return null; // 反転が無い画面は即やめる
  const isRev = (r: number, col: number): boolean => snap.cells[r]?.[col - 1]?.reverse === true;

  let best: WindowRect | null = null;
  let bestArea = 0;
  for (let top = 0; top < snap.rows; top++) {
    for (const t of runs[top] ?? []) {
      if (t.to - t.from + 1 < MIN_REVERSE_FRAME) continue;
      for (let bottom = top + 2; bottom < snap.rows; bottom++) {
        // 下端は同じ桁範囲の「途切れない」連なりであること
        if (!(runs[bottom] ?? []).some((b) => b.from === t.from && b.to === t.to)) continue;
        // 側面: 間のすべての行で左右端が反転
        let closed = true;
        for (let r = top + 1; r < bottom && closed; r++) {
          closed = isRev(r, t.from) && isRev(r, t.to);
        }
        if (!closed) continue;
        // 4. 内側が空いていること。**塗り潰しブロックを弾く唯一の条件**なので外さない
        let hollow = false;
        for (let r = top + 1; r < bottom && !hollow; r++) {
          for (let col = t.from + 1; col < t.to; col++) {
            if (!isRev(r, col)) {
              hollow = true;
              break;
            }
          }
        }
        if (!hollow) continue;
        const area = (bottom - top) * (t.to - t.from);
        if (area > bestArea) {
          bestArea = area;
          best = { row1: top + 1, row2: bottom + 1, col1: t.from, col2: t.to };
        }
      }
    }
  }
  return best;
}

/** 指定桁の文字（無ければ空文字）。桁は 1 始まり。 */
function charAtCol(rt: RowText, col: number): string {
  const i = rt.colOf.indexOf(col);
  return i < 0 ? "" : rt.text[i]!;
}

/**
 * 直近のレコードが**重ね書き**（背景を残したまま画面の一部だけを書く）だったか。
 *
 * 【この条件が反転経路にしか効かない理由 — 実機実測 2026-07-29 / SR-OSAKA・IBM i 7.3】
 *
 * 当初は「本物の窓は背景を消さずに窓の領域だけ書き、通常画面は CLEAR してから全画面を書く」
 * と考え、これを窓判定の第一級条件にしようとした。**実機で半分しか成り立たなかった。**
 *
 * | 画面 | `lastWrite` |
 * |---|---|
 * | Attn の窓（ATNPGM。反転枠） | `cleared=false` / `rect=r18-24`（**部分書き込み**） |
 * | **F1 ヘルプ窓**（`.`／`:` の箱） | **`cleared=true` / `rect=r1-24`（全画面）** |
 * | 通常画面（メニュー・PDM・DSPLIBL） | `cleared=true` / `rect=r1-24`（全画面） |
 *
 * **ヘルプ窓はホストが画面をクリアしてから背景の見出しごと箱を描き直す**ため、受信データ上は
 * 通常画面と区別が付かない（`test/real-help-window.test.ts` に実機 fixture で固定）。
 * ここで CLEAR を「窓ではない」の根拠にすると、**本物のヘルプ窓を落とす**。
 *
 * 一方 Attn 系の窓は重ね書きで来るので、**反転経路に限れば**この条件が効く——
 * 反転バナー（見出し行＋末尾行が反転する通常画面）は CLEAR を伴うので弾ける。
 * 罫線経路（ヘルプ窓が通る道）には**適用しない**。
 */
function isOverlayWrite(snap: ScreenSnapshot): boolean {
  const w = snap.lastWrite;
  if (!w) return true; // 記録が無ければ何も言えない（従来どおりに振る舞う）
  // CLEAR＝画面を作り直した / RESTORE＝退避を戻した。どちらも重ね書きではない
  return !w.cleared && !w.restored;
}

/**
 * 最前面の窓の内側を返す（spec D3）。
 *
 * 1. `gui.windows` があればその最後（＝最前面）を使う。**ホストの宣言が最優先**。
 * 2. 無ければ罫線から検出する。**通常のヘルプ窓は `gui.windows` に出ない**ため
 *    （research F3。文字で描かれる）、この経路が実際にはほとんどを占める。
 * 3. 反転枠（ATNPGM の窓）も見る。**こちらだけ受信データで裏を取る**——
 *    反転は見出し・メッセージ行の強調にも使われ、通常画面を窓と誤検出していた。
 *    Attn 系の窓は実機で**重ね書き**（CLEAR なしの部分書き込み）と確認できたので、
 *    重ね書きでないレコードなら反転は窓ではないと切れる（`isOverlayWrite`）。
 *    罫線経路に同じ条件を掛けてはいけない理由は `isOverlayWrite` の注記を参照。
 * 4. `prev`（直前の画面）が渡されていれば、**枠の外に新しい内容が現れていないか**で
 *    候補の裏を取る（`introducedOutside`）。ヘルプ窓が全画面書き直しで来ても効く唯一の材料。
 *    **省略時は 3 までで終わり＝従来と 1 つも結果が変わらない。**
 */
export function detectWindowRect(
  snap: ScreenSnapshot,
  charOf: CharOf = defaultCharOf,
  prev?: ScreenSnapshot | null
): WindowRect | null {
  const win = snap.gui?.windows;
  if (win && win.length > 0) {
    const w = win[win.length - 1]!;
    // **ホストが送る位置は窓の「中身」ではなく枠の左上。**
    // 中身はその **1 行下・3 桁右**から始まり、大きさは宣言どおり（深さ × 幅）。
    // 枠は中身の上下に 1 行・左右に 2 桁を使い、さらにその左に枠の属性バイトが 1 桁入る。
    //
    // 実機（SR-OSAKA）で 2 つの窓から確かめた。ホストが窓の中の定数を書いた位置が根拠:
    //   GRIDCL4: SBA(16,19) 40x5 に `2 3'EXPLICIT BORDER CHARS'` → 行 18 桁 24
    //   GRIDCL5: SBA(8,24)  30x8 に `2 3'WINDOW CONTENT'`        → 行 10 桁 29
    // どちらも窓相対 (2,3) が絶対 (row+2, col+4) ＝ 中身の原点は (row+1, col+3)。
    //
    // 宣言された位置をそのまま中身と見なしていたため、枠の装飾・スモーク・凡例の
    // 絞り込みが**1 行上・3 桁左**にずれ、窓の最終行と右端 4 桁が範囲から外れていた。
    return {
      row1: w.row + 1,
      row2: w.row + w.height,
      col1: w.col + 3,
      col2: w.col + w.width + 2
    };
  }

  const rows = snap.cells.map((cells) => rowText(cells, snap.cols, charOf));
  const edges: { r: number; from: number; to: number }[] = [];
  rows.forEach((rt, r) => horizontalRuns(rt).forEach((run) => edges.push({ r, ...run })));

  let best: { top: number; bottom: number; from: number; to: number; area: number } | null = null;
  for (let a = 0; a < edges.length; a++) {
    for (let b = edges.length - 1; b > a; b--) {
      const t = edges[a]!;
      const bo = edges[b]!;
      if (bo.r - t.r < 2) continue;
      // 上下の縁は「大きく重なる」ことを条件にする。端の記号（`:`）の有無で 1〜2 桁ずれるため、
      // 厳密一致にすると実データ（F1 ヘルプ）で対にならない。
      const ov = Math.min(t.to, bo.to) - Math.max(t.from, bo.from) + 1;
      const shorter = Math.min(t.to - t.from + 1, bo.to - bo.from + 1);
      if (ov <= 0 || ov / shorter < 0.8) continue;
      // 間の行に縦罫が立っているか（半数以上）。点線の見出し等を窓と誤認しないための条件。
      let v = 0;
      let n = 0;
      for (let r = t.r + 1; r < bo.r; r++) {
        const rt = rows[r];
        if (!rt) continue;
        n++;
        if (BORDER_V.has(charAtCol(rt, t.from)) || BORDER_V.has(charAtCol(rt, t.to))) v++;
      }
      if (n === 0 || v / n < 0.5) continue;
      const area = (bo.r - t.r) * (t.to - t.from);
      if (!best || area > best.area) best = { top: t.r, bottom: bo.r, from: t.from, to: t.to, area };
    }
  }
  // top/bottom は 0 始まりの行 index。内側は枠の 1 つ内なので +2 / そのまま（1 始まり換算）
  const border: WindowRect | null = best
    ? { row1: best.top + 2, row2: best.bottom, col1: best.from + 1, col2: best.to - 1 }
    : null;
  // ATNPGM の窓は枠を反転で描く（罫線文字を使わない）。**両方を見て前面を選ぶ**。
  // **反転経路にだけ受信データの裏を取る**（罫線経路＝ヘルプ窓の道には掛けない。`isOverlayWrite` 参照）
  const reverse = isOverlayWrite(snap) ? detectReverseFrame(snap) : null;
  const candidate = border && reverse && containedIn(reverse, border) ? reverse : (border ?? reverse);

  // **入力欄が枠の外に出ていたら窓ではない**（backlog `window-detect.md` の補助条件）。
  //
  // 罫線経路は条件が緩く、左右に `:` が並ぶ帳票を窓と誤る（実測 ③）。そこで
  // **ホストが差し替えた欄の一覧**で裏を取る——実機（SR-OSAKA / IBM i 7.3）で測ると、
  // 窓が開いた瞬間にホストは欄の一覧を丸ごと入れ替える:
  //
  // | 画面 | 入力欄 |
  // |---|---|
  // | WRKOBJPDM（背景） | **12 個**（見出し・オプション列・コマンド行） |
  // | その上に F1 ヘルプ窓 | **1 個だけ**（r11c9 ＝ 窓の内側） |
  //
  // **本物の窓では背景の欄が残らない**ので、この条件は本物を殺さない。
  // 採取した実データは `test/fixtures/window-stack/real-fields-pdm-help.json`。
  //
  // ⚠ **欄が 1 つも無い画面には掛からない**（条件が空振りする）。ヘルプ窓のように
  // 入力欄を持たない窓が多いので、これは「効くときだけ効く」安価な補助にとどまる。
  if (candidate && hasInputOutside(snap, candidate)) return null;

  // 前画面が渡されていれば「窓は背景の上に開く」ことで裏を取る（`introducedOutside`）。
  // 渡されなければここで終わり＝**従来と 1 つも結果が変わらない**。
  if (!candidate || !prev) return candidate;
  // **表示設定ではなく画面モデルで比べる**（`charOf` を渡さない）。
  // SO/SI マーク表示が ON だと、窓の枠が背景の DBCS を分断して残った SO/SI の片割れが
  // `{` `}` として見え、「新しい内容が現れた」と数えられて**本物の窓が落ちる**
  // （実機 fixture win-wrkmbrpdm-f1 / win-wrkobjpdm-asaolib-f1 の両方で再現）。
  // 差分が答えるべきは「ホストがそこへ新しい内容を置いたか」なので、表示の都合を混ぜない。
  return introducedOutside(prev, snap, candidate) ? null : candidate;
}

/** 2 つの画面が表示上まったく同じか（表示文字と反転だけを見る） */
export function sameScreen(a: ScreenSnapshot, b: ScreenSnapshot, charOf: CharOf = defaultCharOf): boolean {
  if (a.rows !== b.rows || a.cols !== b.cols) return false;
  for (let r = 0; r < a.rows; r++) {
    const ra = a.cells[r];
    const rb = b.cells[r];
    if (!ra || !rb) return false;
    for (let c = 0; c < a.cols; c++) {
      const ca = ra[c];
      const cb = rb[c];
      if (!ca || !cb) return false;
      if (ca.reverse !== cb.reverse || charOf(ca) !== charOf(cb)) return false;
    }
  }
  return true;
}

/**
 * 候補矩形の**外側に新しい内容が現れた**か。現れていれば窓ではない（画面が入れ替わっている）。
 *
 * 【この形に落ち着いた理由 — 実機 34 対（窓 9・通常 25）で実測 2026-07-29】
 *
 * 窓は背景の上に開くので、**枠の外側は前の画面のまま**であるはず。通常画面への遷移なら
 * 枠の外にも新しい内容が出る。受信データ（`WriteExtent`）と違い**画面と画面の差分**なので、
 * ヘルプ窓が全画面書き直しで来ても成立する（そちらの限界は `isOverlayWrite` の注記を参照）。
 *
 * 素直に書くと 2 か所で外す:
 *
 * 1. **`detectWindowRect` が返すのは枠の「内側」。** そのまま外側を測ると
 *    **新しく描かれた枠自体**が変化として数えられ、実測で窓 9 件中 8 件を落とした。
 *    → 外周（±1 行・±1 桁）を含めた矩形の外側を見る
 * 2. **残る差分はすべて `文字→空白` だった**（実測: WRKACTJOB 3・WRKOBJPDM 3・WRKSPLF 14 セル）。
 *    **窓の枠が DBCS 文字の片割れを潰した跡**で、縁の 1〜3 桁に限って出る。
 *    → 「現在が空白かつ非反転」のセルは数えない。これで実測 9/9 が通る
 * 3. **比較は画面モデルで行う**（既定の `charOf`）。呼び出し側の表示用 `charOf` を使うと、
 *    SO/SI マーク表示 ON のとき上記の片割れが `{` `}` として見え、2 の除外をすり抜けて
 *    **本物の窓が落ちる**（実機で再現）。差分が答えるべきは「ホストが新しい内容を置いたか」
 *
 * 画面サイズが変わっているときは比較の意味が無いので**裏取りをしない**（false を返す）。
 *
 * 【既知の制限 — 大きい窓から小さい窓へ戻ると判定が外れる】
 * ヘルプ窓 → F2 拡張ヘルプ（より大きい窓）→ 元のヘルプ窓、と戻ったときに窓と判定されない。
 * 大きい窓が占めていた領域は、戻るときに背景で描き直される。それが**小さい窓の枠の外**に
 * 当たるため「新しい内容が現れた」と数えられてしまう。
 *
 * **この判定が「窓は背景の上に開く＝枠の外は前のまま」という前提に立っている以上、
 * 窓が縮む方向の遷移は原理的に区別できない**（枠外が変わるのは通常画面への遷移と同じ形）。
 * 直すには前画面 1 枚ではなく窓の履歴を持つ必要があり、費用に見合わないと判断した。
 * **制限事項として受け入れる**（利用者判断 2026-07-29）。
 */
function introducedOutside(
  prev: ScreenSnapshot,
  cur: ScreenSnapshot,
  rect: WindowRect,
  charOf: CharOf = defaultCharOf
): boolean {
  if (prev.rows !== cur.rows || prev.cols !== cur.cols) return false;
  // 枠そのものは内側矩形の外にあるので、外周を含めた矩形で測る
  const r1 = rect.row1 - 1;
  const r2 = rect.row2 + 1;
  const c1 = rect.col1 - 1;
  const c2 = rect.col2 + 1;
  for (let r = 1; r <= cur.rows; r++) {
    const inRows = r >= r1 && r <= r2;
    const rowCur = cur.cells[r - 1];
    const rowPrev = prev.cells[r - 1];
    if (!rowCur || !rowPrev) continue;
    for (let c = 1; c <= cur.cols; c++) {
      if (inRows && c >= c1 && c <= c2) continue;
      const cc = rowCur[c - 1];
      const cp = rowPrev[c - 1];
      if (!cc || !cp) continue;
      const now = charOf(cc);
      // 空白になっただけ＝枠が DBCS の片割れを潰した跡。新しい内容が出たわけではない
      if (now === " " && !cc.reverse) continue;
      if (now !== charOf(cp) || cc.reverse !== cp.reverse) return true;
    }
  }
  return false;
}

/**
 * `a` が `b` に完全に収まっているか。
 *
 * **窓が重なったときの前面判定に使う。** 前面の窓は後ろの窓の枠を上書きするので、枠が壊れた側は
 * そもそも検出されない——実機で採った 5 パターンのうち**誤るのは「前面が後ろの内側に収まったとき」
 * だけ**だった（Attn の窓がヘルプ窓の中に出ると、ヘルプの枠が生き残って後ろが選ばれる）。
 * そのケースに限って内側を前面とみなす。
 *
 * 部分的な重なりは扱わない。どちらが前面か判断できないので、従来どおり罫線枠を返して挙動を変えない。
 */
/**
 * 入力できる欄が矩形の外にあるか。
 *
 * **保護欄は見ない。** 背景の見出しや説明文は保護欄で、窓が開いても残ることがある
 * （枠の外に文字があるのは当たり前で、それは窓を否定しない）。**打てる欄**が外にあるときだけ、
 * 「ホストはまだ背景を触らせるつもりだ＝窓ではない」と言える。
 *
 * 欄の**右端まで**見る（`col + length - 1`）。左端だけだと、枠の内側から始まって外へはみ出す
 * 欄を通してしまう。
 */
function hasInputOutside(snap: ScreenSnapshot, rect: WindowRect): boolean {
  for (const f of snap.fields) {
    if (f.protected) continue;
    if (f.row < rect.row1 || f.row > rect.row2) return true;
    if (f.col < rect.col1 || f.col + f.length - 1 > rect.col2) return true;
  }
  return false;
}

function containedIn(a: WindowRect, b: WindowRect): boolean {
  return a.row1 >= b.row1 && a.row2 <= b.row2 && a.col1 >= b.col1 && a.col2 <= b.col2;
}

/** 1 行から凡例を拾う（窓・宣言行の絞り込みは呼び出し側）。 */
/** 凡例 1 件の位置とラベル（`F<n>=` とオプション凡例で共有する土台） */
interface LegendHit {
  row: number;
  col: number;
  width: number;
  label: string;
  /** 見出しの捕獲グループ（`F3=` なら `"3"`、`10=` なら `"10"`） */
  num: string;
}

/**
 * 行から `<見出し>=<ラベル>` の並びを拾う。**`F<n>=`（機能キー）とオプション凡例で共有する。**
 *
 * 別実装にすると、既存レビューで潰した不具合を踏み直す。ここが持つ処理はどちらにも要る:
 *
 * - 桁空間（`RowText`）で走査する＝ DBCS があっても桁がずれない
 * - **ラベルの終わりは「空白 2 個以上」**。空白 1 個は日本語ラベル内にも出る
 *   （実測: `F13= この画面の使用法` / `7=名前の変更`）
 * - 次の凡例の開始位置を hard end にする
 * - **ラベルと占有幅は同じ切り出しから求める**（review R1）。別々に求めると、末尾の罫線を
 *   ラベルからは除いたのに幅には残り、描画は幅で切り出すので**ボタンが隣の罫線を飲み込む**
 *   （実測: `|F3=終了|` で末尾の `|` まで巻き込んでいた）
 */
function legendHitsInRow(rt: RowText, row: number, re: RegExp): LegendHit[] {
  const out: LegendHit[] = [];
  const heads: { num: string; at: number; labelFrom: number }[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(rt.text); m !== null; m = re.exec(rt.text)) {
    heads.push({ num: m[1]!, at: m.index, labelFrom: m.index + m[0].length });
  }
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!;
    const hardEnd = i + 1 < heads.length ? heads[i + 1]!.at : rt.text.length;
    const seg = rt.text.slice(h.labelFrom, hardEnd);
    const cut = seg.search(/\s{2,}/);
    const raw = cut >= 0 ? seg.slice(0, cut) : seg;
    const kept = raw.replace(TRAILING_BORDER, "");
    const label = kept.trim();
    if (!label) continue; // `F3=` だけで中身が無いものは凡例と見なさない
    const endIdx = h.labelFrom + kept.length - 1;
    const col = rt.colOf[h.at]!;
    const lastCol = (rt.colOf[endIdx] ?? rt.colOf[rt.colOf.length - 1]!) + (rt.widthOf[endIdx] ?? 1) - 1;
    out.push({ row, col, width: lastCol - col + 1, label, num: h.num });
  }
  return out;
}

function legendsInRow(rt: RowText, row: number): FkeySpan[] {
  const out: FkeySpan[] = [];
  for (const h of legendHitsInRow(rt, row, LEGEND_RE)) {
    const n = Number(h.num);
    if (n < 1 || n > 24) continue; // AID に存在しないキーは拾わない
    out.push({ row: h.row, col: h.col, width: h.width, key: `F${n}` as AidKey, label: h.label });
  }
  return out;
}

/**
 * 画面全体から凡例を検出する。
 *
 * - 窓があれば**内側だけ**（spec D3）。窓の外＝下の画面の凡例は、ラベルが切れていたり
 *   （`F13= この画`）、押すと前面の窓の文脈で解釈されてラベルと食い違う（`F3= 終了` → 実際はヘルプ終了）。
 * - `gui.selectionFields` がある行は**ホストの宣言を優先**して検出しない（spec FR-8）。
 */
export function detectFkeyLegends(snap: ScreenSnapshot, charOf: CharOf = defaultCharOf): FkeySpan[] {
  const rect = detectWindowRect(snap, charOf);
  const declaredRows = new Set((snap.gui?.selectionFields ?? []).map((f) => f.row));
  const out: FkeySpan[] = [];
  for (let r = 0; r < snap.rows; r++) {
    const row = r + 1;
    if (declaredRows.has(row)) continue;
    if (rect && (row < rect.row1 || row > rect.row2)) continue;
    const cells = snap.cells[r];
    if (!cells) continue;
    for (const s of legendsInRow(rowText(cells, snap.cols, charOf), row)) {
      if (rect && (s.col < rect.col1 || s.col + s.width - 1 > rect.col2)) continue;
      out.push(s);
    }
  }
  return out;
}

/**
 * オプション凡例の見出し（`2=` `10=`）。
 * **負の後読みが要**——付けないと `F3=` の `3` を拾ってしまう（`F<n>=` 側は機能キーが扱う）。
 */
const OPTION_RE = /(?<![A-Za-z0-9])(\d{1,2})\s*=\s*/g;

/** オプション凡例 1 件（`2=変更`）。座標は 1 始まりの桁。 */
export interface OptionSpan {
  row: number;
  col: number;
  width: number;
  /** 欄へ入れる番号（`"2"` / `"10"`） */
  value: string;
  label: string;
}

/** Opt 欄の列（同じ桁・同じ長さの非保護欄が縦に並ぶ） */
export interface OptionColumn {
  col: number;
  length: number;
  /** 並んでいる行（昇順） */
  rows: number[];
}

/** Opt 列とみなす最小の行数。一覧は実機 5 画面で 7〜10 行あった */
const MIN_OPTION_ROWS = 3;
/** Opt 欄の最大桁数（実機は 1〜2） */
const MAX_OPTION_LEN = 2;

/**
 * **Opt 欄の列**を探す。同じ桁・同じ長さ（1〜2）の非保護欄が、連続する行に 3 行以上並ぶもの。
 *
 * 【この形にした根拠 — 実機 SR-OSAKA・IBM i 7.3 で 5 画面を実測 2026-07-29】
 *
 * | 画面 | Opt 欄 | 並ぶ行 |
 * |---|---|---|
 * | `WRKOBJPDM` | c2 / len2 | 11–18 |
 * | `WRKSPLF`   | c2 / len2 | 12–20 |
 * | `WRKACTJOB` | c2 / len2 | 10–18 |
 * | `DSPLIBL`   | c3 / len1 | 9–15 |
 * | `WRKUSRJOB` | c2 / len2 | 9–18 |
 *
 * 5/5 で同じ形をしていた。`WRKMSGQ` にはこの形が無く、正しく何も返さない。
 *
 * **これ単独では窓を開けない**——凡例と揃って初めて有効にする（`detectOptionHints`）。
 * 「短い欄が縦に並ぶ」だけなら数量入力の画面にもあり得るため。
 */
export function detectOptionColumn(snap: ScreenSnapshot): OptionColumn | null {
  const byKey = new Map<string, number[]>();
  for (const f of snap.fields) {
    if (f.protected || f.length < 1 || f.length > MAX_OPTION_LEN) continue;
    const key = `${f.col}/${f.length}`;
    const list = byKey.get(key);
    if (list) list.push(f.row);
    else byKey.set(key, [f.row]);
  }
  let best: OptionColumn | null = null;
  for (const [key, rowsRaw] of byKey) {
    const rows = [...rowsRaw].sort((a, b) => a - b);
    // 連続する行の最長の連なりを取る（見出し行を挟んで飛んでいるものは別の塊とみなす）
    let runFrom = 0;
    for (let i = 1; i <= rows.length; i++) {
      if (i < rows.length && rows[i]! === rows[i - 1]! + 1) continue;
      const run = rows.slice(runFrom, i);
      if (run.length >= MIN_OPTION_ROWS && (!best || run.length > best.rows.length)) {
        const [colStr, lenStr] = key.split("/");
        best = { col: Number(colStr), length: Number(lenStr), rows: run };
      }
      runFrom = i;
    }
  }
  return best;
}

/**
 * 画面から**オプション凡例と Opt 列**を取り出す。どちらか欠ければ `null`。
 *
 * **両方揃ったときだけ返すのが要**。`<数字>=` は `F<n>=` よりはるかに紛れやすく
 * （金額・式・日付）、凡例だけを根拠にすると誤検出が利用者に見える。
 * backlog も「Opt 欄の存在・凡例行との位置関係で絞ること」と指示している。
 *
 * 凡例は **Opt 列の最小行より上**から拾う。実機の PDM は 2 行にまたがるので 1 行に限定しない。
 * 窓が開いていれば窓の中だけを見る（`detectFkeyLegends` と同じ考え方）。
 */
export function detectOptionHints(
  snap: ScreenSnapshot,
  charOf: CharOf = defaultCharOf
): { column: OptionColumn; options: OptionSpan[] } | null {
  const column = detectOptionColumn(snap);
  if (!column) return null;

  const rect = detectWindowRect(snap, charOf);
  const top = column.rows[0]!;
  const seen = new Set<string>();
  const options: OptionSpan[] = [];
  for (let r = 1; r < top; r++) {
    if (rect && (r < rect.row1 || r > rect.row2)) continue;
    const cells = snap.cells[r - 1];
    if (!cells) continue;
    for (const h of legendHitsInRow(rowText(cells, snap.cols, charOf), r, OPTION_RE)) {
      if (rect && (h.col < rect.col1 || h.col + h.width - 1 > rect.col2)) continue;
      // 欄に収まらない番号は選ばせない（長さ 1 の欄に `10` は入らない）
      if (h.num.length > column.length) continue;
      if (seen.has(h.num)) continue; // 同じ番号が 2 回出たら先に出た方を採る
      seen.add(h.num);
      options.push({ row: h.row, col: h.col, width: h.width, value: h.num, label: h.label });
    }
  }
  return options.length > 0 ? { column, options } : null;
}
