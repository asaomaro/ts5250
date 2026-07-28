# 調査: 忠実再現 HTML の実装に必要な事実

requirement.md の「未確定事項」と、research 推奨の根拠だった 3 点を潰す。

## 1. `ScreenGrid.vue` の描画規則（＝忠実さの正解）

3,416 行のうち、HTML へ写すべき規則は次のとおり。

### 1-1. セグメント化（`rows()`）

1 行を 4 種のセグメントに割る。**同じ属性クラスの連なりは 1 つの `text` ランにまとめる**
（DOM を減らすため。27x132 = 3,564 セルを 1 セル 1 要素にしない）。

| kind | 条件 | 描き方 |
|---|---|---|
| `input` | フィールド内 | `<input>`（HTML では**読み取り専用の span に置き換える**） |
| `wide` | `dbcs-lead && !isCertainWideGlyph(shown)` | **2ch 幅の箱**。フォントに依らず 2 桁を占めさせる |
| `half` | 対を失った全角（lead に tail 無し／孤児 tail） | **1ch 幅の箱**。ACS と同じ「分断された見え方」 |
| `text` | 上記以外 | 属性クラスをまとめた素のラン |

**`wide` の存在理由が最重要**——East Asian Width が Ambiguous な DBCS 文字
（U+2212 `−`・U+2010 `‐`・罫線・ギリシャ等）は欧文等幅フォントが 1 桁で描くため、
素のランに混ぜると以降の桁が左へずれる（PDM の F1 ヘルプ「オプション−ヘルプ」で実測）。
`isCertainWideGlyph`（`composables/fieldValidate.ts`）が「どのフォントでも確実に 2 桁」の
範囲を持ち、そこから外れる全角だけ箱に入れる。

- `dbcs-tail` で lead がある桁は**スキップ**（lead の 1 文字が 2 桁ぶんを占める）。
- **確実に全角のグリフでも `dbcs-tail` 側は箱に入れる**——素のランへ積むとフォントが
  2 桁で描き、それがそのまま桁ずれになる。

### 1-2. 座標系

- 桁 = `ch` 単位、行高 = **`1.25em`**。
- `.grid` は `padding: 8px 10px`。**絶対配置で重ねる要素は `margin: 8px 0 0 10px` で補正**が要る
  （PR #191 で `.grid-line` / `.win-frame` / `.gui-window-border` / `.win-title` に追加した）。
  → **HTML 側では `.grid` に padding を置かなければこの補正自体が不要**になる。設計で padding を持たせない。

### 1-3. 罫線（`gridSegments`）

- **セルの中ではなく「セルの境界」に引く**。`top = row-1` / `left = col-1` /
  `bottom = top + max(1,height)` / `right = left + max(1,width)`。
  行番号・桁番号のまま置くと下辺と右辺が 1 つ内側に寄り、**箱が閉じない**。
- 色は 5250 の属性バイトではなく **GRDATR 専用コード**（`GRID_COLOR[g.color] ?? "white"`）。
  `decodeAttribute` に渡すと全部緑になる。
- **単独罫線（minorType 0x00–0x03）は `value1`/`value2` が「繰り返し数・間隔」**、
  箱（0x04–0x07）は「横罫の行間隔・縦罫の桁間隔」。同じ 2 バイトを型で読み分ける。
- **ホストの指定どおりの色・線種で描く**（ACS に合わせない。既決事項）。

### 1-4. 窓

- `gui.windows` の枠＋ `WDWBORDER`（`hostBorderRows` が罫線文字、`hostBorderSegments` が線）＋
  `WDWTITLE`（`hostTitle`。辺の中央／左／右寄せ、脚注は下辺）。
- `hostBorderSegments` の `cls` は **`win-frame` と `gui-window-border` を同一要素に載せる**。
- 文字で描かれた窓（`gui.windows` に出ない通常のヘルプ窓）は `detectWindowRect()` が
  罫線文字から検出する。**HTML では窓装飾は対象外**（requirement のスコープ）だが、
  `gui.windows` の枠は対象。

### 1-5. 属性クラス

`cellClass()` が `c-<color>` ＋ `a-underline` / `a-reverse` / `a-blink` / `a-colsep` を付ける。
**黄・青緑では桁区切りビットを立てない**（`hasRealColsep`。PR #191）。
CSS 変数（`--t-green` 等）と `.a-reverse { background: var(--cell); color: var(--crt) }` は
`styles.css` にあるので、**HTML 側へは値を焼き込む**（外部 CSS を参照しないため）。

## 2. 履歴の受け皿 — **`Session5250` は既に画面更新イベントを出している**

`packages/core/src/session/session.ts`:

- `Emitter` を継承し、画面が更新されるたび **`this.emit("screen", snap)`**（`:468`、GUI 選択は `:238`）。
- `waitForScreen()` はこのイベントを購読して実装されている（`:342-354`）。
- `packages/server/src/ws-handler.ts:104` も `entry.session.on("screen", onScreen)` で購読し
  ブラウザへ push している。**購読者を増やす前例がある。**

→ **履歴レコーダは `session.on("screen", …)` を購読するだけでよい。** 新しい通知経路は要らない。

`AuditBuffer`（`packages/server/src/audit.ts`）が**リングバッファ＋`installAuditBuffer` で
既存 sink に連結**する形の前例になっており、同じ流儀で `SessionEntry` に持たせられる。

### 記録の開始・終了をどうするか（設計判断の材料）

| 方式 | 利点 | 欠点 |
|---|---|---|
| **常時記録**（全セッション） | 呼び出し側が何もしなくてよい | **全セッションのメモリを常時消費**。秘密（入力値）が常に溜まる |
| **明示 start/stop** | 要るときだけ。秘密の露出範囲を絞れる | ツールが 2 つ増える。stop 忘れでメモリが残る |

`requirement.md` の制約「`hidden` の値を出さない」「監査ログにフィールド値を記録しない既存方針を
崩さない」と合わせると、**明示 start/stop ＋ 上限付きリングバッファ**が素直。
記録するのは `ScreenSnapshot` と送信 AID キーまでとし、**入力値は記録しない**。

## 3. フォントと桁ズレ — **箱で解決済み。外部フォントは不要**

web-ui は `composables/screenFonts.ts` が Local Font Access で導入済みフォントを列挙し、
無ければ canvas 実測にフォールバックして「和欧 1:2 の一体フォント」を選ぶ。
**配布 HTML ではこの手が使えない**（requirement の唯一の技術リスクとして挙げた点）。

だが調査の結果、**そもそも `ScreenGrid` はフォント選択に頼りきっていない**——
1-1 の `wide` / `half` セグメントが `width: 2ch` / `1ch` の箱で幅を強制しており、
Ambiguous な文字はフォントに依らず桁を保つ。

→ **HTML でも同じ手が使える。** 必要なのは「ASCII が等幅であること」だけで、これは
`font-family: ui-monospace, monospace` で満たせる。さらに安全側に倒すなら、
**確実に全角の文字も含めて全角セルをすべて 2ch の箱に入れる**（`isCertainWideGlyph` の
分岐自体を落とす）ことで、フォント依存を完全に除ける。DOM は増えるが、
1 画面あたり全角セル数ぶんなので許容範囲。

**結論: 外部フォントの埋め込みは不要。技術リスクは解消した。**

## 4. その他の確認

- **`recodes()` / `sbcsView`**（PR #192）: 表示コード再解釈は web-ui 側の表示設定であり、
  `ScreenSnapshot` には現れない。**HTML はホストの表のまま（`auto` 相当）で描く**のが素直。
- **`0x1C` が書いた `"*"`** は `rawByte` を持たない（PR #191 修正H）。再解釈対象外で整合する。
- **`attributeRuns()`**（`packages/server/src/format.ts`）が既に「表示属性の変わり目」を
  run で返す。**HTML のラン化ロジックはこれと同じ考え方**だが、こちらは
  「既定の見た目（緑・装飾なし）を落とす」ので、そのままは使えない（HTML は全セルが要る）。

## 5. research の結論

| requirement の未確定事項 | 結論 |
|---|---|
| 履歴をどこに持つか | `SessionEntry` にリングバッファ。`session.on("screen")` を購読（`AuditBuffer` と同じ流儀） |
| 記録の開始・終了 | **明示 start/stop ツール**＋上限付きバッファ。常時記録はメモリと秘密の両面で不利 |
| 何を記録するか | `ScreenSnapshot` ＋送信 AID キー。**入力値は記録しない** |
| 容量・上限 | リングバッファの件数上限。あふれたら古いものから捨てる |
| ツールを分けるか | 単票／履歴／記録制御で分ける（引数で分岐させると必須引数の組み合わせが濁る） |
| 変換ロジックの置き場 | `@as400web/core` のブラウザ安全サブパス。web-ui からも将来使える |
| フォントの桁ズレ | **解決済み**。全角セルを `2ch` の箱に入れればフォント非依存 |
