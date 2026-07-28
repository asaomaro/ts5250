# 仕様: 5250 画面の忠実再現 HTML

前提は `requirement.md` と `research.md`。research で未確定事項はすべて解決済み。

## 1. 置き場と公開面

| 追加 | 中身 |
|---|---|
| `packages/core/src/html/screen-html.ts` | 変換の本体（純関数のみ。`node:*` 非依存） |
| `packages/core/src/browser.ts` | `renderScreenHtml` / `renderScreenHistoryHtml` を再輸出 |
| `packages/core/src/index.ts` | 同上（サーバー側 MCP ツールが使う） |

`ScreenGrid.vue` に依存しない。`GRID_COLOR`（`protocol/wdsf-parser.ts`）と
`screen/types.ts` の型だけ使う。

## 2. 公開 API

```ts
/** エビデンスのメタ情報。**日時は呼び出し側が渡す**（変換関数は Date を呼ばない＝決定的） */
export interface ScreenHtmlMeta {
  capturedAt?: string;   // ISO 8601。呼び出し側が date を取る
  sessionId?: string;
  host?: string;
  job?: string;
  title?: string;
  note?: string;
}

/** 履歴 1 コマ。画面と、その画面を出した操作 */
export interface ScreenHistoryEntry {
  screen: ScreenSnapshot;
  /** この画面の直前に送った AID キー（最初の画面は無し） */
  key?: string;
  capturedAt?: string;
  note?: string;
}

export function renderScreenHtml(snap: ScreenSnapshot, meta?: ScreenHtmlMeta): string;
export function renderScreenHistoryHtml(entries: readonly ScreenHistoryEntry[], meta?: ScreenHtmlMeta): string;
```

**両者は同一の内部関数 `screenFigure()` で 1 画面を描く**（requirement §2「描画経路を二重に持たない」）。
履歴版はそれを並べてナビを被せるだけ。

## 3. 1 画面の DOM

```html
<figure class="scr" data-rows="24" data-cols="80">
  <div class="crt">
    <div class="grid">
      <div class="ln"><span class="c-green">COMMAND</span><span class="w c-white">日</span>…</div>
      … rows 行 …
      <!-- 重ねる要素（文字より上） -->
      <div class="cur" style="left:9ch;top:6.25em"></div>
      <div class="gw" style="…"></div>          <!-- gui.windows の枠 -->
      <div class="gl c-white gl-h" style="…"></div> <!-- 罫線 -->
    </div>
  </div>
  <div class="oia">…</div>
</figure>
```

- **`.grid` に padding を置かない**。`ScreenGrid.vue` が必要としていた `margin: 8px 0 0 10px` の
  補正（PR #191）は、padding が無ければ**そもそも要らない**。ずれの原因を構造的に消す。
- 行高 `1.25em`、桁 `ch`。`.grid` は `position: relative`。

### 3-1. セルのラン化（`ScreenGrid.vue` の `rows()` を簡約）

| 条件 | 出力 |
|---|---|
| `dbcs-lead` かつ次が `dbcs-tail` | **`<span class="w …">` = `width:2ch` の箱** |
| `dbcs-tail` かつ前が `dbcs-lead` | **スキップ**（lead が 2 桁ぶんを占める） |
| 対を失った `dbcs-lead` / `dbcs-tail` | **`<span class="h …">` = `width:1ch` の箱**（ACS と同じ分断表示） |
| それ以外 | 属性クラスが同じ連なりを 1 つの `<span>` にまとめる |

**全角は `isCertainWideGlyph` で分岐せず、すべて箱に入れる。** research §3 のとおり、
これでフォント依存が完全に消える（配布 HTML は Web フォントを持てないため、
`ScreenGrid.vue` より安全側に倒す）。DOM は全角セル数ぶんしか増えない。

`nonDisplay` は空白。`so`/`si` は空白 1 桁（画面と同じ桁勘定）。`char === ""` は空白。

### 3-2. 属性クラス

`c-green` / `c-white` / `c-red` / `c-turquoise` / `c-yellow` / `c-pink` / `c-blue`
＋ `a-u`（下線）/ `a-r`（反転）/ `a-b`（点滅）/ `a-cs`（桁区切り）。

**黄・青緑では桁区切りを出さない**（`hasRealColsep` と同じ規則。PR #191 の既決事項）。
点滅は `@media (prefers-reduced-motion: reduce)` でアニメを止める。

### 3-3. 入力欄

`snap.fields` の範囲に `data-field` を持たせ、`.f`（保護は `.fp`）で下線を出す。
**`<input>` は使わない**（読み取り専用のエビデンス。押せる/打てる部品を置かない）。
`hidden` フィールドの値は**セルから来る**ので、`nonDisplay` として既に空白になっている
（`snap.fields[].value` は使わない＝秘密を書かない）。

### 3-4. 重ねる要素

- **カーソル**: `left:(col-1)ch; top:(row-1)*1.25em; width:1ch; height:1.25em`。
- **罫線**（`gui.gridLines`）: research §1-3 の幾何をそのまま移植する。
  境界は `top = row-1` / `left = col-1` / `bottom = top+max(1,height)` / `right = left+max(1,width)`。
  単独罫線（`minorType <= 0x03`）は `value1`=繰り返し数・`value2`=間隔、
  箱（0x04–0x07）は `value1`=横罫の行間隔・`value2`=縦罫の桁間隔。
  色は `GRID_COLOR[g.color] ?? "white"`。線種は実線/点線/破線。
- **窓**（`gui.windows`）: 枠の矩形。`WDWBORDER` の罫線文字があれば文字で描く。
  `WDWTITLE` は辺に載せる（中央/左/右・脚注は下辺）。
- **拡張 5250 部品**: 選択フィールド（ラジオ ◉○ / チェック ☑☐ / プッシュボタン）と
  スクロールバー。**選択状態と選択不可の区別を残す**。押せない見た目にする。

### 3-5. OIA

`ScreenSnapshot` から導ける項目だけ: カーソル位置（行/列）・画面サイズ・
キーボードロック・`systemMessage`。**ライブ UI 状態と AID ボタンは置かない**（requirement）。

## 4. テーマ

`:root` にダーク（既定）、`:root[data-theme="light"]` にライトの CSS 変数を焼き込む
（`styles.css` の `--crt` / `--t-*` の実値）。ヘッダのボタンが `data-theme` を切り替える。
**JS はテーマ切替と履歴ナビだけ**。JS を切っても画面は読める。

## 5. 履歴版

- 全コマを 1 つの HTML に入れ、現在のもの以外は `hidden`。
- 前/次ボタン、`←`/`→` キー、コマ一覧（送信キーと日時）。
- **画面の描画は単票と完全に同一**（`screenFigure()` を共有）。

## 6. 安全性

- **HTML エスケープ**: `&` `<` `>` `"` `'` を必ず変換。画面文字・窓見出し・メタ情報の
  すべてがホスト由来。属性値にも同じ関数を使う。
- **id を出さない**（複数の HTML を同じディレクトリに置いても干渉しない）。
  スタイルは `.scr` 配下に限定し、要素の対応付けはクラスと `data-*` で行う。
- **決定的**: 関数内で `Date.now()` / `Math.random()` を呼ばない。

## 7. MCP ツール（`packages/server/src/mcp-tools.ts`）

| ツール | 入力 | 出力 |
|---|---|---|
| `get_screen_html` | `sessionId` | `html`（単票） |
| `start_screen_recording` | `sessionId`, `limit?` | `recording: true` |
| `stop_screen_recording` | `sessionId` | `recording: false`, `frames` |
| `get_screen_history_html` | `sessionId`, `clear?` | `html`, `frames` |

### 履歴バッファ（`packages/server/src/session-manager.ts`）

`SessionEntry` に `recorder?: ScreenRecorder` を足す。`start` で
`session.on("screen", …)` を購読し、リングバッファへ積む（既定上限 100 コマ）。
`stop` で `off`。**入力値は記録しない**（`ScreenSnapshot` と送信キーのみ）。
`AuditBuffer`（`audit.ts`）と同じ流儀。

セッション終了時に必ず `off` する（リーク防止）。

## 8. テスト

| # | 対象 | 内容 |
|---|---|---|
| T1 | core | 同じ snapshot から 2 回生成した HTML が完全一致（決定的） |
| T2 | core | `<script>` や `"` を含むホスト文字列でも壊れず注入されない |
| T3 | core | DBCS が 2ch の箱に入り、対を失った全角は 1ch になる |
| T4 | core | 7 色・反転・下線・点滅・桁区切りのクラスが出る／黄・青緑は桁区切りを出さない |
| T5 | core | 外部リソース（`http`/`//`/`url(`/`@import`/`src=`）を一切参照しない |
| T6 | core | 罫線の幾何（箱が閉じる・単独罫線の繰り返し） |
| T7 | core | 履歴版が単票と同じ画面マークアップを含む（描画経路が 1 本） |
| T8 | server | 録画バッファが上限で古いものを捨てる／stop で購読を外す |

## 9. 検証

```
npm run build
cd packages/core && npx vitest run
cd packages/server && npx vitest run
npx eslint <変更した core/server のファイル>
```
