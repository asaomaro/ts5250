# 原典（Bugfix.pdf）の書き起こし

`Bugfix.pdf`（18 ページ・全ページ画像／テキスト層なし）を、埋め込み JPEG を取り出して読み取った結果。
**取り込みの原典はこのファイルではなく PDF 本体**だが、PDF は画像なので grep できない。
実装中の照合と、取り込み漏れの追跡のためにここへ書き起こす。

- 文書1: 16 ページ（2026.07.28 16:58 出力）— 修正 A〜I
- 文書2: 2 ページ（2026.07.28 17:22 出力）— 修正 J

原典の注意書き: **このファイルは複数回書き直されている。旧版が別環境に適用済みの場合は
必ずこの最新版で上書きすること**（旧版のままだと不具合 3・4・5・6・7・8 が残る/再発する）。

---

## 背景（実機トレースで確認した事実）

`AS400_TRACE_RECORDS=1` を付けて起動すると受信 5250 レコードの生バイト列が 16 進でログに出る
（`packages/server/src/session-manager.ts` の `traceRecordsEnabled()`）。障害切り分け専用。
これで実機のバイト列を採取し、`applyDataStream` / `ScreenBuffer` に直接通して挙動を検証した。

- **CLEAR UNIT ALTERNATE（0x20）** は SFLCTL(SFLDSPCTL) を持つ画面（YB0270R 等）の 1 回の画面構築の中で
  何度も送られてくる。`WRITE KSN20`（罫線を描く WDSF）の直後にも送られてきており、
  これが GUI 構造体を毎回消す実装だと、描いた直後に罫線が消えて二度と描き直されない。
- **CLEAR UNIT（0x40）** は PB1000R で CREATE WINDOW の窓を閉じて呼び出し元の画面へ戻るときに使われる。
  この場面では `REM_GUI_WINDOW`(0x59) や `REM_ALL_GUI_CONSTRUCTS`(0x5F) のような専用コマンドは
  一切送られてこず、素の CLEAR UNIT だけで窓が暗黙に消えることを期待している。
- つまり **0x40 と 0x20 は GUI 構造体に対する実際の意味が異なる**。
  0x40 は GUI も含めて画面を丸ごと作り直す合図、0x20 は「同じ画面の中でサイズ/文字セルだけ整え直す」合図。
- **RESTORE SCREEN（ESC 0x12）は別経路**。SAVE SCREEN 時点の GUI 構造体スナップショットを正しく復元するので
  元々問題ない。

---

## 【修正A】CLEAR UNIT ALTERNATE で GUI 構造体（罫線含む）を消さない

`resize()`（`clearUnitAlternate()` から呼ばれる共通処理）から `this.clearGui()` の呼び出しを削除する。
GUI を消すかどうかは呼び出し側（`clearUnit()` か `clearUnitAlternate()` か）の責任にする。

--- diff: `packages/core/src/screen/buffer.ts` ---

`private resize()` の直前に doc コメントを追加し、末尾の `this.clearGui()` を削除:

```
+  /**
+   * **文字セル・サイズだけを変更する共通処理。GUI 構造体には触れない――呼び出し側の責任。**
+   *
+   * `clearUnitAlternate()` から呼ぶときは GUI 構造体（窓・選択フィールド・スクロールバー・
+   * 罫線）を残す。CLEAR UNIT ALTERNATE は SFLCTL の再描画のたびに何度も送られてくる
+   * （実機・YB0270R で確認。KSN20 罫線が「一度描かれた直後に消える」不具合の原因
+   * だった）。罫線は WDSF の専用コマンド（Clear Grid Line Buffer 0x61・GRDATR/GRDLIN
+   * 主構造の flag1 bit0 等）で寿命管理されており、CLEAR UNIT ALTERNATE 側で消す必要はない。
+   *
+   * 一方 `clearUnit()` は自分で `clearGui()` を追加で呼ぶ（実機 PB1000R で、CREATE WINDOW
+   * の窓を閉じるときに素の CLEAR UNIT だけで窓を暗黙に消すことを確認したため）。
+   * つまり GUI 構造体を消すかどうかはコマンドの種類（0x40 と 0x20）で実際に異なる――
+   * ここでは両者に共通する「文字セル・サイズ」の変更だけを行う。
+   */
   private resize(rows: 24 | 27, cols: 80 | 132): void {
     this.rows = rows;
     this.cols = cols;
     this.cells = new Array<InternalCell>(rows * cols).fill(null);
     this.fields = [];
     this.retainedEnds.clear(); // 画面の中身ごと消えるので引き継ぎも捨てる
     this.cursorAddr = 0;
     this.systemMessage = undefined;
-    this.clearGui();
   }
```

※ `clearGui()` 自体（GUI 構造体をすべて除去するメソッド）は削除しない。
`REM_ALL_GUI_CONSTRUCTS`（`wtd-applier.ts` の `"remove-all"` ケース）からは引き続き呼ばれる必要がある。

---

## 【修正D】CLEAR UNIT は GUI 構造体を消す（`clearUnit()` を独立させる）

背景: 修正Aだけを適用すると `clearUnit()` も `resize()` 経由で GUI を消さなくなってしまい、
PB1000R のように「素の CLEAR UNIT だけで窓を暗黙に消す」実装のホストでは窓の枠が消えずに残る。

修正: `clearUnit()` は `resize(24, 80)` を呼んだ後、自分で明示的に `clearGui()` を呼ぶ。
`resize()` 自体からは GUI クリアを外したまま（修正Aのとおり）にして、`clearUnitAlternate()` には
波及しないようにする。あわせて `clearUnit()` 内にあった「サイズが既に 24x80 なら `resize()` を呼ばず
手動で同じ処理をする」という分岐は、`resize()` を無条件に呼んでも結果が同じなので削除して単純化した。

--- diff: `packages/core/src/screen/buffer.ts` ---

```
-  /** CLEAR UNIT: 既定サイズ（24x80）でクリア */
+  /**
+   * CLEAR UNIT: 既定サイズ（24x80）でクリアし、GUI 構造体も消す。
+   *
+   * **CLEAR UNIT ALTERNATE（`clearUnitAlternate()`）とは違い、こちらは GUI 構造体を消す。**
+   * 実機（PB1000R）のトレースで、CREATE WINDOW で出した窓を閉じて呼び出し元の
+   * 画面へ戻るとき、REM_GUI_WINDOW 等の専用コマンドを送らず、素の CLEAR UNIT だけで
+   * 窓を暗黙に消していることを確認した（RESTORE SCREEN で戻る実装もあるが、それとは別の経路）。
+   * CLEAR UNIT ALTERNATE 側で GUI を消さないようにしたときと同じ理屈を逆向きに適用している
+   * ――各コマンドが実機で実際にどう使われているかで判断するしかない。
+   */
   clearUnit(): void {
-    if (this.rows !== 24 || this.cols !== 80) {
-      this.resize(24, 80);
-      return;
-    }
-    this.cells.fill(null);
-    this.fields = [];
-    this.retainedEnds.clear(); // 画面の中身ごと消えるので引き継ぎも捨てる
-    this.cursorAddr = 0;
-    this.systemMessage = undefined;
+    this.resize(24, 80);
     this.clearGui();
   }
```

※ 修正A・Dを両方適用した最終形:
- `resize()`（private・共通処理）: 文字セル/サイズだけを変更。GUI には触れない。
- `clearUnit()`（CLEAR UNIT 0x40）: `resize()` を呼んだ上で `clearGui()` も呼ぶ。
- `clearUnitAlternate()`（CLEAR UNIT ALTERNATE 0x20）: `resize()` だけ呼ぶ。GUI は触らない
  （元のコードのまま変更なし）。

---

## 【修正B】単独罫線（GRDLIN）の value1/value2 既定値バグ

これは修正 A/D ほど致命的ではないが、同時に見つかった実在のバグなので合わせて直した
（この修正だけでは KSN20 の「全く表示されない」症状は解決しない。実際の原因は修正Aだった）。

背景: `GRDLIN((*POS ...) (*TYPE LEFT))` のように繰り返し引数を省略した単独罫線
（`minorType` 0x00〜0x03）で、ホストが `value1`/`value2` に `GRID_DEFAULT`(0xFF) を送ってくるケースがある
（GRDBOX 側は実機で確認済み。単独罫線は実測では value1/value2=1 が来ており未確認だが、同じ理屈で起こり得る）。
`ScreenGrid.vue` の単独罫線描画は `Math.max(1, g.value1)` で繰り返し本数を決めるため、`value1` が
0xFF(=255) のまま渡ると「255 本を 255 間隔で引け」という意味不明な指定になってしまう。
`color`/`lineStyle` には「0xFF ならレコード既定値にフォールバック」という処理が既にあるのに、
`value1`/`value2` には無かった。

修正: `applyGridLines()` で `value1`/`value2` も `GRID_DEFAULT` なら 0 に倒す。
（0 なら単独罫線側は `Math.max(1,0)`=1 本、箱側は `value1 > 0` 判定で内部罫線なし、という
双方にとって正しい既定動作になる）

--- diff: `packages/core/src/screen/buffer.ts`（`applyGridLines` 内）---

```
       lineStyle: it.lineStyle !== GRID_DEFAULT ? it.lineStyle : parsed.defaultLine,
       color: it.color !== GRID_DEFAULT ? it.color : parsed.defaultColor,
-      value1: it.value1,
-      value2: it.value2
+      // **未指定（ホストがバイトを送ってこない）は 0 に倒す。** 単独罫線（0x00-0x03）は
+      // ScreenGrid.vue が `Math.max(1, value1)` で 1 本に、箱（0x04-0x07）は `value1 > 0` の
+      // 判定で内部罫線なしになる――どちらも「繰り返し・間隔を指定しない」の正しい既定値。
+      // ここを GRID_DEFAULT（0xFF）のまま渡すと単独罫線が「255 本を 255 間隔で」引かれてしまう
+      // （GRDLIN((*TYPE LEFT)) のように繰り返し引数を省略した DSPF で発生。KSN20 で確認）。
+      value1: it.value1 !== GRID_DEFAULT ? it.value1 : 0,
+      value2: it.value2 !== GRID_DEFAULT ? it.value2 : 0
     });
```

---

## 【修正C】罫線・WDWBORDER 枠の表示位置が上・左に数px ずれる

根本原因: `packages/web-ui/src/components/ScreenGrid.vue` の `.grid` コンテナは `padding: 8px 10px;` を持つ。
この上に絶対配置（`position: absolute`）で重ねる要素は、CSS 仕様上 `top:0; left:0` が
「`.grid` の padding box の角」に揃うため、実際の文字位置（padding の内側）に合わせるには
`margin: 8px 0 0 10px` を足して補正する必要がある。

この補正は `.cursor`（カーソル）・`.rect-sel`（矩形選択）・`.win-deco`/`.win-smoke`（装飾窓枠）・
`.gui-window`（拡張GUIの窓）・`.win-title`（窓見出し）・`.gui-scrollbar`（スクロールバー）には
すでに入っていたが、**罫線関連の 3 つ（`.grid-line`・`.win-frame`・`.gui-window-border`）だけ
この補正が抜けていた**。これが上・左へのズレの原因。

修正: 上記 3 つの CSS ルールに `margin: 8px 0 0 10px;` を追加する。

--- diff: `packages/web-ui/src/components/ScreenGrid.vue` ---

```
 .grid-line {
   position: absolute;
+  margin: 8px 0 0 10px; /* .gui-window と同じグリッド padding 分の補正 */
   pointer-events: none;
 }

 .win-frame {            /* WDWBORDER で色だけ指定したときの枠線 */
   position: absolute;
+  margin: 8px 0 0 10px; /* .gui-window と同じグリッド padding 分の補正 */
   pointer-events: none;
 }

 .gui-window-border {    /* WDWBORDER で罫線文字を指定したときの枠 */
   position: absolute;
+  margin: 8px 0 0 10px; /* .gui-window と同じグリッド padding 分の補正 */
   white-space: pre;
   pointer-events: none;
   line-height: 1.25;
 }
```

---

## 【修正E】黄・青緑フィールドの頭に不要な桁区切り（縦線）が出る

これは罫線（GRDLIN）とは無関係の、5250 の表示属性バイトの解釈に関する不具合。
利用者からのスクリーンショット報告（`"{対象外}"` のような黄色反転ハイライトのフィールドの頭に、
DDS が頼んでいない縦棒が出る）で見つかった。

根本原因: 5250 の属性バイト表（SC30-3533、0x20〜0x3F。`packages/core/src/screen/attributes.ts` の
`ATTR_TABLE`）には、**黄色（yellow）・青緑（turquoise）だけ「修飾なしの単色」を表す値が存在しない**。
黄は 0x32（桁区切り付き）・0x33（桁区切り＋反転付き）・0x36（下線付き）・0x37（非表示）の 4 通りしか無く、
青緑も同様に 0x30/0x31（桁区切り付き）・0x34/0x35（下線付き）の 4 通りしかない。
つまり `COLOR(YLW)` を単体で（下線も付けずに）指定しただけでも、コンパイラは桁区切りビット付きの値
（0x32 か反転時 0x33）を選ばざるを得ず、**受信した属性バイトだけを見ても DSPATR(CS) を本当に頼んだのか、
単に黄色にしただけなのかを区別できない**。

この制約は既に窓の見出し・枠（`ScreenGrid.vue` の `decorAttrClass()`）では考慮されていて、
黄・青緑のときは桁区切りを一切出さないようにしていた（ACS の画素確認済み）。しかし通常のフィールド
（`cellClass()`・`attrByteClass()`）には同じ考慮が適用されておらず、黄・青緑地のフィールドの頭に
意図しない縦棒（`.a-colsep` の `border-left`）が出ていた。

修正: `cellClass()` と `attrByteClass()` に、色が yellow/turquoise のときは `columnSeparator` を無視する
共通ヘルパー `hasRealColsep()` を追加し、両関数の `a-colsep` 付与判定をこれに差し替える。

--- diff: `packages/web-ui/src/components/ScreenGrid.vue` ---

```
 /** cell の属性を CSS class 文字列にする */
+/**
+ * **桁区切り（CS）ビットは黄・青緑では「書き手の意図」の印にならない。**
+ *
+ * 5250 の属性バイト表（SC30-3533）には黄・青緑を「修飾なし」で表す値が無く、
+ * `COLOR(YLW)` を単体で指定しただけでも桁区切りビット付きの値（0x32 等）に
+ * コンパイルされる（属性バイトだけを見ても DSPATR(CS) を本当に頼んだのか区別できない）。
+ * 窓の見出し・枠（decorAttrClass）は既にこれを踏まえて桁区切りを出さないようにしていたが、
+ * 通常のフィールドには適用しておらず、黄字の欄の頭に意図しない縦棒が出ていた
+ * （利用者からのスクリーンショット報告で判明）。
+ */
+function hasRealColsep(color: string, columnSeparator: boolean): boolean {
+  return columnSeparator && color !== "yellow" && color !== "turquoise";
+}
+
 function cellClass(c: Cell): string {
   const cls = [`c-${c.color}`];
   if (c.underline) cls.push("a-underline");
   if (c.reverse) cls.push("a-reverse");
   if (c.blink) cls.push("a-blink");
   // DSPATR(CS)＝桁区切り。core は解析してセルに持っていたが、描画側が**素通ししていた**ため
   // DSPF の区切り線が画面に一切出ていなかった（dspf-report (1)）。
-  if (c.columnSeparator) cls.push("a-colsep");
+  if (hasRealColsep(c.color, c.columnSeparator)) cls.push("a-colsep");
   return cls.join(" ");
 }

 function attrByteClass(byte: number): string {
   const a = decodeAttribute(byte);
   const cls = [`c-${a.color}`];
   if (a.underline) cls.push("a-underline");
   if (a.reverse) cls.push("a-reverse");
   if (a.blink) cls.push("a-blink");
-  if (a.columnSeparator) cls.push("a-colsep"); // cellClass と同じ体裁（片方だけ落とさない）
+  if (hasRealColsep(a.color, a.columnSeparator)) cls.push("a-colsep"); // cellClass と同じ体裁（片方だけ落とさない）
   return cls.join(" ");
 }
```

※ `decorAttrClass()`（窓の見出し・枠用）は変更不要。元々 `columnSeparator` を一切見ておらず
（常に桁区切りを出さない、より厳しいルール）、今回の `hasRealColsep()` はそれを通常フィールドにも
部分的に広げたもの。

---

## 【修正F】未知の 5250 オーダーに当たると「応答待ちのまま固まる」

これは罫線とは無関係の不具合。`AS400_TRACE_RECORDS=1` で採取した実機の生バイト列に、以下の警告が
出ていた（サーバーログ、component: `session-5250`）:

```
unknown order 0x1c — discarding rest of record
```

その約 30 秒後、Enter キー操作の監査ログに `durationMs:30007`（＝タイムアウト一杯まで待った）が
記録されていた。「応答待ちのまま固まる」の直接証拠。

根本原因: 受信したレコードの途中に、WTD（Write To Display）の中の 1 バイトとして `0x1C` が現れる。
5250 のオーダー体系（`packages/core/src/protocol/constants.ts` の `ORDER`。実機準拠の参照実装 tn5250
（GitHub: hharte/tn5250、lib5250/codes5250.h）でも確認したが、`0x15`(WDSF) と `0x1D`(SF) の間の
`0x16`〜`0x1C` は本来空き番地で、tn5250 自身も定義していない）。
**問題は `0x1C` の正体そのものではなく、未知のオーダーに当たった時点でレコードの残り全部を捨てていたこと**
（`applyWtd` の default 分岐で `r.skip(r.remaining); return;`）。今回のレコードでは、この `0x1C` の
**数百バイトあと**にキーボード解放（CC2 unlock ビット）と READ コマンドが来ており、これらが丸ごと
失われるため、ホストは応答したつもりでもクライアントの鍵盤が開かないまま止まっていた。

修正: 未知のオーダーに当たったら、レコード全体ではなく**次の ESC(0x04) バイトまで読み飛ばして
次のコマンドから復帰する**ようにする。ESC(0x04) は表示データ（0x40 以上）にも他のオーダーにも
現れないので、この読み飛ばし方は安全。未知オーダーを含む画面の一部は表示が欠けたままになるが、
それ以降のコマンド（キーボード解放・READ 等）は正常に適用される。

--- diff: `packages/core/src/protocol/wtd-applier.ts` ---

`applyDataStream` の直前の doc コメントを更新:

```
 /**
  * 1 レコード分のデータストリーム（ESC+コマンド列）を ScreenBuffer に適用する。
- * 未知のコマンド/オーダーは警告してレコードの残りを打ち切る（レコード境界で再同期。spec「エラー処理」）。
+ *
+ * 未知のコマンド（ESC 直後の 1 バイト）は警告してレコードの残りを打ち切る
+ * （レコード境界で再同期。spec「エラー処理」）。**未知のオーダー（WTD の中の 1 バイト）は
+ * 次の ESC まで読み飛ばして次のコマンドから復帰する**――ここでレコード全部を捨てると、
+ * 未知のオーダーより後ろにある WRITE（キーボード解放）や READ ごと失われ、
+ * ホストは応答したつもりでもクライアントの鍵盤が開かないまま固まる
+ * （実機で正体不明のオーダーに当たったときに観測）。
  */
 export function applyDataStream(
```

`applyWtd` の order ループ、default 分岐を書き換え:

```
     default:
-      warn(`unknown order 0x${b.toString(16)} — discarding rest of record`);
-      // オーダー長が不明なため、このレコードの残りは安全に読めない
-      r.skip(r.remaining);
+      warn(`unknown order 0x${b.toString(16)} — skipping to next command`);
+      // **オーダーの長さは分からないが、レコード全体を捨てない。**
+      // ESC(0x04) は表示データ（0x40 以上）にも他のオーダーにも現れないので、
+      // 次の ESC まで読み飛ばして次のコマンドから復帰できる。ここでレコードの
+      // 残り全部を捨てると、後続の WRITE（キーボード解放の CC2 等）や READ が
+      // 丸ごと失われ、ホストは送ったつもりでもクライアントの鍵盤が開かず
+      // 「応答待ちのまま固まる」（実機で正体不明のオーダーに当たったときに観測）。
+      while (r.remaining > 0 && r.peek() !== ESC) r.u8();
       return;
   }
 }
```

---

## 【修正G】0x1C の正体を突き止め、欠落していたデータも復元する

修正Fの時点では「未知オーダーに当たっても記録全体を捨てない」という延命措置だけで、`0x1C` 自体の
正体・意味は未解決のままだった。標準システム画面「スプール・ファイルの表示」（DSPSPLF 系）で、
修正F適用後も見出し行より後ろのサブファイル明細データ（部品コード・数量等）が表示されない、という
利用者報告がきっかけで再調査した。

**原因調査（1回目・不十分だった）**: 修正Fと同じ実機トレース（3130 バイトのレコード）を、SO/SI を
正しく辿って EBCDIC/DBCS を全文デコードするスクリプトに通し、`0x1C` の前後の文脈を読める形にした。
結果、`0x1C` は**見出し行の最後のラベル「仕入先」が桁末尾（132 桁目付近）で「仕」まで打ち切られた直後、
サブファイルの明細データ（`0****`・`96270106`・`26/05/08` 等）が始まる直前**という、フィールド境界の
ような位置に**レコード中で一度だけ**現れていた。SC30-3533 にも tn5250 にも定義が無いため正体は特定できず、
**パラメータを持たない 1 バイトの区切りとして無視する（no-op）**という前提で実装した。
この時点ではデコードスクリプトの結果は ACS の画面表示とほぼ一致しているように見えた。

→ **だがこれは不十分だった。** 利用者が ACS の実際の表示を再確認したところ、見出しの最後は「仕」だけでなく
**「仕*」**（「仕」の直後に `"*"` が 1 文字ある）ことが分かった。no-op 実装では `"*"` が 1 文字欠けたまま
出ており、利用者のスクリーンショット比較（「ACSでは仕*、当方は仕」）で発覚した。

**原因調査（2回目・訂正）**: `0x1C` は**表示上 `"*"` 1 文字を描画する 1 バイトオーダー**である
（パラメータは無し。`"*"` の分だけ桁を 1 つ占有し、続く表示データはその 1 桁ぶん後ろにずれる）。
画面下部に同じ「スプール・ファイルの表示」が出す「データ行で印刷桁の調整が行われた。」というメッセージがあり、
印刷用データを画面幅（今回は 132 桁）に収めるために桁を詰めた境界を示す印だと見られる（未確定・要再確認）。

修正: `ORDER.UNKNOWN_1C`（0x1C）を「`"*"` 1 文字を書いて 1 桁進める」オーダーとして実装する。
正体（5250 プロトコル上の正式名称）は未確認のままであることをコメントで明示した。

--- diff: `packages/core/src/protocol/constants.ts` ---

`ORDER` に `UNKNOWN_1C` を追加（`WDSF: 0x15` と `SF: 0x1d` の間）:

```
 export const ORDER = {
   SOH: 0x01, // Start of Header
   RA: 0x02, // Repeat to Address
   EA: 0x03, // Erase to Address
   TD: 0x10, // Transparent Data
   SBA: 0x11, // Set Buffer Address
   WEA: 0x12, // Write Extended Attribute
   IC: 0x13, // Insert Cursor
   MC: 0x14, // Move Cursor
   WDSF: 0x15, // Write to Display Structured Field
+  /**
+   * **正体未確認。SC30-3533 / tn5250（lib5250/codes5250.h）のどちらにも定義が無い
+   * （0x15〜0x1D の間の空き番地）。実機の標準システム画面「スプール・ファイルの表示」
+   * （DSPSPLF 系）のトレースで 1 回だけ観測した――桁末尾で打ち切られた DBCS 見出し
+   * フィールドの直後・サブファイル明細データの直前という、フィールド境界のような位置。
+   * 画面下部に「データ行で印刷桁の調整が行われた。」という同システムのメッセージが
+   * 出ており、印刷用データを画面幅に収めるために桁を詰めた境界を示す印だと見られる。**
+   * 表示は "*" 1 文字（パラメータ無し、1 桁占有）。ACS の実際の表示（"仕*"）と
+   * 突き合わせて確定した――当初は 0 引数の読み飛ばし（no-op）として実装したが、
+   * その版では "*" が 1 文字欠けたまま出ていた（利用者のスクリーンショット比較で発覚）。
+   * 実際の 5250 プロトコル上の正式名称・意味までは未確認（要再確認）。
+   */
+  UNKNOWN_1C: 0x1c,
   SF: 0x1d // Start of Field
 } as const;
```

--- diff: `packages/core/src/protocol/wtd-applier.ts` ---

`applyWtd` の switch に case を追加（`WDSF` の case の直後・`default` の直前）:

```
     case ORDER.WDSF: {
       applyWdsf(r, buf, codec, addr, warn);
       break;
     }
+    case ORDER.UNKNOWN_1C:
+      // 表示は "*" 1 文字（桁を 1 つ占有）。詳細は ORDER.UNKNOWN_1C の doc コメント参照。
+      buf.setChar(addr++, "*", b);
+      break;
     default:
```

（※ この `b` 引数は**修正H で外す**。下記参照。）

---

## 【修正H】0x1C の "*" がカナ表示モードでだけ文字化けする

修正Gの直後に発覚。利用者が Web UI の表示モードを「カナモード」と「英モード」で切り替えて比較したところ、
**英モードでは "仕 *" と正しく出るが、カナモードでは "*" の位置が別の文字（半角カナ）に化ける**、という
報告があった（スクリーンショット 2 枚での比較で発覚）。ACS ではどちらのモードでも "*" のまま。

根本原因: 修正Gの実装 `buf.setChar(addr++, "*", b)` は、第 3 引数 `rawByte` に `b`
（＝オーダー自身の識別バイト `0x1C`）をそのまま渡していた。`rawByte` は本来「その桁に実際に届いた
EBCDIC 文字バイト」を保持するためのフィールドで、Web UI の「カタカナ表示モード」
（`ScreenGrid.vue` の `props.katakanaView`）は、SBCS セルに `rawByte` があれば
「これは半角カナとして生バイトから再解釈しよう」と処理する:

```ts
if (props.katakanaView && c.kind === "sbcs" && c.rawByte !== undefined) {
  return displayText(katakanaChar(c.rawByte));
}
```

`0x1C` は「受信した文字バイト」ではなく「このオーダー自身を表す識別バイト」でしかないのに、これを
`rawByte` として持たせてしまったため、カナ表示モードで `katakanaChar(0x1c)` に通され、制御コード範囲の
値を半角カナとして無理やり解釈した結果、文字化けした。

修正: `rawByte` を渡さない（`buf.setChar(addr++, "*")` のみ）。`rawByte` が `undefined` なら
`katakanaView` の再解釈条件（`c.rawByte !== undefined`）に当たらず、素の `"*"` がそのまま表示される。

--- diff: `packages/core/src/protocol/wtd-applier.ts` ---

```
     case ORDER.UNKNOWN_1C:
       // 表示は "*" 1 文字（桁を 1 つ占有）。詳細は ORDER.UNKNOWN_1C の doc コメント参照。
-      buf.setChar(addr++, "*", b);
+      // **rawByte は渡さない。** 0x1C は実際に受信した EBCDIC 文字バイトではなく
+      // このオーダー自身の識別バイトなので、rawByte として持たせるとカタカナ表示
+      // モード（ScreenGrid.vue の katakanaView）がこれを生バイトとして半角カナに
+      // 再解釈してしまい、"*" のはずが文字化けする（利用者報告で発覚）。
+      buf.setChar(addr++, "*");
       break;
```

---

## 【残課題（修正Gに関して）】

`0x1C` が実際どの 5250 プロトコル機能・DDS キーワードに対応するのか、規格上の正式な裏付けは
取れていない。今回は実機の 1 パターン（DBCS 見出しフィールドが桁末尾で打ち切られた直後・
印刷桁調整の境界）でのみ観測・検証した。「パラメータ無しで `"*"` 1 文字を表示する」という前提が
別の文脈でも常に正しいかは未確認――もし別の画面で `0x1C` を挟んで表示が崩れる（表示位置がずれる・
想定と違う文字が出る等）ケースが見つかったら、その実機トレースを取り、ACS の実際の表示と
突き合わせて再検証すること。

今回の教訓として、**デコード結果が「それらしく見える」だけでは不十分で、ACS の実際の画面と
1 文字単位で突き合わせて初めて確定できる**、という点はこのファイル全体（特に修正E・G）に共通する。

---

## 【修正I】WRITE ERROR CODE の日本語メッセージが文字化けする

罫線・0x1C とは無関係の別系統の不具合。利用者から「文字化けするエラーメッセージがある」という報告があり、
`AS400_TRACE_RECORDS=1` のトレースで確認した。

根本原因: `packages/core/src/protocol/wtd-applier.ts` の `applyWriteErrorCode()`
（WRITE ERROR CODE、コマンド 0x21。画面下部のエラー行のメッセージを `systemMessage` に持つ処理）が、
**SO/SI・DBCS を一切考慮していなかった**。受信バイトを 1 バイトずつ `codec.decodeByte()`（SBCS 前提）に
通していたため、日本語（DBCS）のメッセージが SO(0x0E)…SI(0x0F) で挟まれて送られてくると、
DBCS の 2 バイト 1 組がそれぞれ無関係な SBCS 文字としてデコードされ、文字化けしていた。

実機トレース例（96 バイトのレコード）:
```
04 21 22 0e 45 79 47 4f 43 87 43 58 44 9d 48 b6 45 b6 44 cd 44 87
44 a4 44 8f 44 bd 43 41 0f 40 40 ...
```
ESC + WRITE_ERROR_CODE(0x21) の後、SO(0x0e) で DBCS モードに入り 12 組の DBCS ペアが続き、SI(0x0f) で閉じる。
修正前はこれを 1 バイトずつ SBCS デコードして文字化けしていた。修正後は正しく
「機能キーは使用できません。」とデコードされる。

修正: `applyWriteErrorCode()` に、`applyWtd()` の主ループと同じ SO/SI・DBCS ペア処理を追加する。

--- diff: `packages/core/src/protocol/wtd-applier.ts` ---

```
-/** WRITE ERROR CODE: エラー行のメッセージを systemMessage として保持する（表示行への描画は簡略化） */
+/**
+ * WRITE ERROR CODE: エラー行のメッセージを systemMessage として保持する（表示行への描画は簡略化）。
+ *
+ * **SO/SI で挟まれた DBCS（漢字）は 2 バイト 1 組で読む。** 1 バイトずつ `decodeByte` に
+ * 通すと、DBCS のペアがそれぞれ無関係な SBCS 文字に化ける（メッセージが日本語のとき、
+ * 画面下部のエラー行が文字化けする不具合として利用者から報告された）。
+ */
 function applyWriteErrorCode(r: ByteReader, buf: ScreenBuffer, codec: Codec): void {
   let msg = "";
+  let dbcsMode = false;
   while (r.remaining > 0 && r.peek() !== ESC) {
     const b = r.u8();
+    if (b === SO) {
+      dbcsMode = true;
+      continue;
+    }
+    if (b === SI) {
+      dbcsMode = false;
+      continue;
+    }
+    if (dbcsMode && codec.decodeDbcsPair && b >= 0x40) {
+      const b2 = r.u8();
+      msg += String.fromCharCode(codec.decodeDbcsPair(b, b2));
+      continue;
+    }
     if (b >= 0x40) msg += String.fromCharCode(codec.decodeByte(b));
     else if (b === ORDER.IC || b === ORDER.SBA || b === ORDER.MC) r.skip(2);
     // その他の制御は読み飛ばす
   }
   const trimmed = msg.trim();
```

※ SO/SI（`import { SO, SI } from "@as400web/ebcdic";`）はファイル冒頭で既にインポート済み
（`applyWtd` の主ループが使っている）。新規 import は不要。

---

## テストの変更・追加（修正A〜E）

### 1) `packages/core/test/wdsf-gui.test.ts`

既存テスト「CLEAR UNIT で GUI がクリアされる」の期待値自体は変えていない（修正D後は元の挙動＝
GUI が消えるに戻ったため）。実機トレースの根拠を説明するコメントだけを追加した。

```
+  /**
+   * **CLEAR UNIT は GUI 構造体も消す（CLEAR UNIT ALTERNATE とは違う）。**
+   *
+   * 実機（PB1000R）のトレースで、CREATE WINDOW の窓を閉じて呼び出し元へ戻るとき、
+   * REM_GUI_WINDOW 等を送らず素の CLEAR UNIT だけで窓を暗黙に消していることを確認した。
+   * 一方 CLEAR UNIT ALTERNATE は SFLCTL の再描画で何度も送られてくるが GUI は消さない
+   * （YB0270R の KSN20 罫線のテスト、wdsf-applier-grid-lines.test.ts 参照）。
+   * 同じ「画面クリア」でもコマンドの種類（0x40 と 0x20）で GUI への影響が違う。
+   */
   it("CLEAR UNIT で GUI がクリアされる", () => {
     const buf = withOne();
     applyDataStream(Uint8Array.from([ESC, COMMAND.CLEAR_UNIT]), buf, codec, () => {});
     expect(buf.snapshot("t", false).gui).toBeUndefined();
   });
 });
```

### 2) `packages/core/test/wdsf-grid-border.test.ts`

`value1`/`value2` の既定値フォールバックの回帰テストを追加（describe `"ScreenBuffer のグリッド線状態"` の
最後、`"項目が色・線種を指定していればそちらを使う"` の `it()` の直後に追加）。

```
     expect(g.color).toBe(0x01);
     expect(g.lineStyle).toBe(0x08);
   });
+
+  /**
+   * **value1/value2 が既定（0xFF）の項目は 0 に倒す。**
+   * `color`/`lineStyle` と同じ扱い。ScreenGrid.vue の単独罫線（0x00〜0x03）は
+   * `Math.max(1, value1)` で本数を決めるので、0xFF (=255) を素通しすると
+   * 「255 本を 255 間隔で引け」という意味不明な指定になってしまう。
+   * 実機の YB0270R/KSN20 では単独罫線に繰り返し無し指定時 value1/value2=1 が来ており
+   * この経路には当たらなかったが（実測は wdsf-applier-grid-lines.test.ts 参照）、
+   * `GRDBOX` 側は 0xFF がそのまま来る実測がある（本ファイルの PLAIN_BOX テスト）ため、
+   * 単独罫線でも 0xFF が来た場合に備えて既定値を正しく倒しておく。
+   */
+  it("繰り返し無し（value1/value2 既定 0xFF）は 0 に倒す", () => {
+    const buf = new ScreenBuffer();
+    apply(buf, gridBody({}, [
+      item(GRID_MINOR.LEFT_VERTICAL, { row: 3, col: 23, h: 23, rep: 0xff, interval: 0xff })
+    ]));
+    const g = buf.snapshot("t", false).gui.gridLines[0]!;
+    expect(g.value1).toBe(0);
+    expect(g.value2).toBe(0);
+  });
 });
```

### 3) `packages/core/test/wdsf-applier-grid-lines.test.ts`（新規ファイル）

修正Aの根本原因（CLEAR UNIT ALTERNATE が罫線を消す）を再現する統合テスト。ファイル全文:

```ts
import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { ESC, COMMAND, ORDER } from "../src/protocol/constants.js";
import { codecForCcsid } from "@as400web/ebcdic";

const codec = codecForCcsid(930);

/** WDSF 構造体（class 0xD9 + type + body）を WTD オーダーとして包む */
function wdsf(type: number, body: number[]): number[] {
  const sf = [0xd9, type, ...body];
  const ll = sf.length + 2; // LL は自身 2 バイトを含む
  return [ORDER.WDSF, (ll >> 8) & 0xff, ll & 0xff, ...sf];
}

/** グリッド線 1 本（GRDLIN 単独罫線・LEFT）の Draw/Erase Grid Lines 主構造＋マイナー構造 */
const gridDrawBody = [
  0x01,
  0x20,
  0x00,
  0x20,
  0x00,
  0x0f, // defaultColor（GRDATR((*COLOR HWHT))）
  0x00, // defaultLine
  0x0b,
  0x02,
  0x00,
  0x05,
  0x02,
  0x00,
  0x14,
  0xff,
  0xff,
  0x01,
  0x01 // GRDLIN((*POS (5 2 20)) (*TYPE LEFT))
];

function writeToDisplay(orders: number[]): number[] {
  return [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x20, ...orders];
}

/**
 * **KSN00/KSN20（YB0200RD・YB0270RD）の罫線が全く表示されない不具合の再現テスト。**
 *
 * 実機のトレースで、`WRITE KSN20`（罫線を描く）の直後に
 * **CLEAR UNIT ALTERNATE が送られてくる**ことを確認した。SFLCTL(SFLDSPCTL) を持つ
 * 画面（YB0270R）の 1 回の画面構築の中で何度も現れる、ごく普通の 5250 データストリーム。
 *
 * ところが `ScreenBuffer.clearUnitAlternate()`（→ `resize()`）は常に `clearGui()` を
 * 呼んでおり、既に描いたばかりの罫線を含む GUI 構造体を丸ごと消していた。
 * ホストは画面を切り替えるときは REM_ALL_GUI_CONSTRUCTS 等を明示的に送ってくる
 * （同じトレースで確認）ので、CLEAR UNIT ALTERNATE 側で GUI を消す必要はない。
 */
describe("CLEAR UNIT ALTERNATE と罫線の共存", () => {
  it("罫線を描いた直後の CLEAR UNIT ALTERNATE で罫線が消えない", () => {
    const buf = new ScreenBuffer({ alternate: "27x132" });
    const stream = [
      ...writeToDisplay(wdsf(0x60, gridDrawBody)),
      ESC,
      COMMAND.CLEAR_UNIT_ALTERNATE,
      0x00
    ];
    applyDataStream(Uint8Array.from(stream), buf, codec, () => {});
    const gui = buf.snapshot("t", false).gui;
    expect(gui?.gridLines).toHaveLength(1);
    expect(gui!.gridLines[0]).toMatchObject({ minorType: 0x02, row: 5, col: 2, height: 20 });
  });

  it("REM_ALL_GUI_CONSTRUCTS では引き続き罫線が消える（専用コマンドは効く）", () => {
    const buf = new ScreenBuffer({ alternate: "27x132" });
    const stream = [
      ...writeToDisplay(wdsf(0x60, gridDrawBody)),
      ...writeToDisplay(wdsf(0x5f, [0x00]))
    ];
    applyDataStream(Uint8Array.from(stream), buf, codec, () => {});
    expect(buf.snapshot("t", false).gui).toBeUndefined();
  });
});
```

※ 修正D（CLEAR UNIT が GUI を消す）の**直接の**回帰テストは、既存の `wdsf-gui.test.ts`
「CLEAR UNIT で GUI がクリアされる」がそのままそれに当たる（`withOne()` で窓を作ってから
CLEAR UNIT を適用し、`gui` が `undefined` になることを確認している）。新規ファイルを追加する必要は無かった。

### 4) `packages/web-ui/test/screen-grid-colsep.test.ts`

修正Eの回帰テストを 2 件追加（describe `"DSPATR(CS) 桁区切りの描画"` の最後、既存の
`"他の属性と併用できる"` の `it()` の直後に追加）。

```
     expect(span!.classes()).toContain("a-underline");
     expect(span!.classes()).toContain("c-red");
   });
+
+  /**
+   * **黄・青緑は桁区切りビットを落とす。**
+   *
+   * 5250 の属性バイト表（SC30-3533）には黄・青緑を「修飾なし」で表す値が無く、
+   * `COLOR(YLW)` を単体で指定しただけでも桁区切りビット付きの値にコンパイルされる
+   * （属性バイトだけでは DSPATR(CS) を本当に頼んだのか区別できない）。窓の見出し・枠
+   * では既にこれを踏まえて桁区切りを出さないようにしていたが、通常のフィールドには
+   * 適用しておらず、黄字の欄の頭に意図しない縦棒が出ていた（利用者報告で判明）。
+   */
+  it("黄地のセルには columnSeparator が立っていても a-colsep を出さない", () => {
+    const cells = blank();
+    cells[3]![10] = cell("A", { columnSeparator: true, color: "yellow" });
+    const w = mount(ScreenGrid, { props: { snapshot: snapWith(cells), edits: new Map(), focused: true } });
+    expect(w.html()).not.toContain("a-colsep");
+  });
+
+  it("青緑地のセルには columnSeparator が立っていても a-colsep を出さない", () => {
+    const cells = blank();
+    cells[3]![10] = cell("A", { columnSeparator: true, color: "turquoise" });
+    const w = mount(ScreenGrid, { props: { snapshot: snapWith(cells), edits: new Map(), focused: true } });
+    expect(w.html()).not.toContain("a-colsep");
+  });
 });
```

---

## テストの変更（修正F）

`packages/core/test/wtd-applier.test.ts` の既存テスト「未知オーダーは警告して残りを打ち切る」を、
新しい挙動（復帰する）を検証する内容に書き換えた。

```
-  it("未知オーダーは警告して残りを打ち切る", () => {
-    const { warns } = apply([
+  /**
+   * **未知オーダーは警告するが、レコード全体は打ち切らない（次の ESC まで読み飛ばす）。**
+   *
+   * 実機で正体不明のオーダー（0x1C 等）に当たった直後の WRITE（キーボード解放）・READ が
+   * 丸ごと失われ、ホストは応答したつもりでもクライアントの鍵盤が開かず
+   * 「応答待ちのまま固まる」不具合として利用者から報告された。ESC(0x04) は表示データにも
+   * 他のオーダーにも現れないので、次の ESC まで読み飛ばして次のコマンドから復帰できる。
+   */
+  it("未知オーダーは警告するが次の ESC から復帰する（レコード全体は打ち切らない）", () => {
+    const { warns, buf, result } = apply([
       ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
-      0x1c, // DUP 等・01 では未対応オーダー
-      ...e("X")
+      0x16, // 0x15(WDSF)〜0x1D(SF) の間の未使用番地。まだ未対応のオーダー
+      ...e("X"), // 読み飛ばされ、画面には出ない
+      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x08, // CC2 unlock
+      ORDER.SBA, 1, 1, ...e("HELLO"),
+      ESC, COMMAND.READ_MDT_FIELDS, 0x00, 0x00
     ]);
     expect(warns).toHaveLength(1);
+    expect(warns[0]).toContain("0x16");
+    expect(rowText(buf, 1)).toContain("HELLO"); // 未知オーダー後続のコマンドも適用される
+    expect(result.unlockKeyboard).toBe(true); // キーボード解放が失われない
+    expect(result.readRequested).toBe(true);
   });
```

※ 修正F の時点では例バイトに `0x1c` を使っていたが、修正G で `0x1c` の正体が判明し専用対応が
入ったため、**修正G の diff で `0x16` に差し替えている**（上の diff は差し替え後の最終形）。

---

## テストの変更・追加（修正G）

`packages/core/test/wtd-applier.test.ts`:
- 既存の「未知オーダー」テストが例として使っていたバイト値 `0x1c` は、修正Gでもう「未知」では
  なくなったため、別の未対応バイト `0x16` に差し替えた（上記に反映済み）。
- `0x1C` が `"*"` 1 文字を表示し、後続の表示データを取りこぼさないことを確認するテストを新規追加した。

```
+  /**
+   * **0x1C は "*" 1 文字を表示する（正体未確認・実機表示との突き合わせで確定）。**
+   *
+   * 実機の標準システム画面「スプール・ファイルの表示」（DSPSPLF 系）のトレースで観測。
+   * 桁末尾で打ち切られた DBCS 見出しフィールドの直後・サブファイル明細データの直前に
+   * 一度だけ現れ、以前はここで「未知オーダー」として警告されレコードの残りが失われて
+   * いた（利用者の報告では、見出し以降のデータ行が丸ごと表示されない症状だった）。
+   * 当初は 0 引数の読み飛ばし（no-op）として直したが、ACS の実際の表示（"仕*"）と
+   * 突き合わせたところ "*" が 1 文字欠けていた（利用者のスクリーンショット比較で発覚）。
+   * "*" は 1 桁占有するので、続く表示データは 1 桁分後ろにずれて正しい位置に来る。
+   */
+  it('0x1C は "*" 1 文字を表示し、後続の表示データを取りこぼさない', () => {
+    const { warns, buf } = apply([
+      ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00,
+      ORDER.SBA, 1, 1, ...e("A"),
+      ORDER.UNKNOWN_1C,
+      ...e("B")
+    ]);
+    expect(warns).toEqual([]);
+    expect(rowText(buf, 1)).toContain("A*B");
+  });
```

## テストの変更（修正H）

`packages/core/test/wtd-applier.test.ts` の「0x1C は "*" 1 文字を表示し、後続の表示データを
取りこぼさない」テストに、`rawByte` が付かないことのアサーションを追加した（doc コメントにも経緯を追記）。

```
     expect(warns).toEqual([]);
     expect(rowText(buf, 1)).toContain("A*B");
+    const cell = buf.snapshot("t", false).cells[0]?.[1];
+    expect(cell?.rawByte).toBeUndefined(); // カタカナ表示モードで再解釈されない
   });
```

---

## テストの変更・追加（修正I）

`packages/core/test/wtd-applier.test.ts` の既存テスト「WRITE_ERROR_CODE が systemMessage に載る」の
直後に、実機トレースの生バイト列をそのまま使う DBCS の回帰テストを追加した。

```
   it("WRITE_ERROR_CODE が systemMessage に載る", () => {
     const { buf } = apply([ESC, COMMAND.WRITE_ERROR_CODE, ...e("CPF1120 - User not found")]);
     expect(buf.snapshot("t", false).systemMessage).toBe("CPF1120 - User not found");
   });
+
+  /**
+   * **WRITE_ERROR_CODE の DBCS（漢字）メッセージが文字化けしない。**
+   *
+   * 実機のトレースで、日本語のエラーメッセージ（"機能キーは使用できません。"）が
+   * SO/SI で挟まれた DBCS として送られてきた。以前の実装は 1 バイトずつ decodeByte に
+   * 通していたため、DBCS のペアがそれぞれ無関係な SBCS 文字に化けていた
+   * （画面下部のエラー行が文字化けする不具合として利用者から報告された）。
+   */
+  it("WRITE_ERROR_CODE の DBCS メッセージが文字化けしない（実機トレース）", () => {
+    const codec930 = codecForCcsid(930);
+    const record = Uint8Array.from([
+      0x00, 0x60, 0x12, 0xa0, 0x00, 0x00, 0x04, 0x00, 0x00, 0x03, 0x04, 0x21, 0x22,
+      0x0e, 0x45, 0x79, 0x47, 0x4f, 0x43, 0x87, 0x43, 0x58, 0x44, 0x9d, 0x48, 0xb6,
+      0x45, 0xb6, 0x44, 0xcd, 0x44, 0x87, 0x44, 0xa4, 0x44, 0x8f, 0x44, 0xbd, 0x43,
+      0x41, 0x0f, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
+      0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
+      0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
+      0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
+      0x20, 0x04, 0x52, 0x00, 0x00
+    ]);
+    const buf = new ScreenBuffer();
+    const warns: string[] = [];
+    applyDataStream(parseRecord(record).data, buf, codec930, (w) => warns.push(w));
+    expect(warns).toEqual([]);
+    expect(buf.snapshot("t", false).systemMessage).toBe("機能キーは使用できません。");
+  });
```

※ `codecForCcsid` と `parseRecord` はファイル冒頭で既にインポート済み。

---

## 再現・検証手順（別環境での適用後の確認方法）

1. 上記の diff を該当ファイルに適用する（`buffer.ts` / `ScreenGrid.vue` / `constants.ts` /
   `wtd-applier.ts`）。テストファイルの変更・新規追加も適用する
   （無くても本体の修正だけで直るが、回帰防止のため推奨）。
2. ビルド:
   ```
   npm run build -w @as400web/core
   npm run build -w @as400web/web-ui
   （または start.sh --build で一括）
   ```
3. 動作確認:
   ```
   cd packages/core && npx vitest run
   cd packages/web-ui && npx vitest run
   npx eslint .                                   （リポジトリルートで）
   npx vue-tsc -b tsconfig.json tsconfig.test.json （packages/web-ui で）
   ```
   すべて成功すること。
4. 実機接続で以下を確認する:
   - a) YB0200R（DSP20 の KSN20）または YB0270R（CTL20/SFL20 の KSN20）を表示し、罫線が最初から
     最後まで表示され、文字位置とぴったり重なること。
   - b) PB1000R のような CREATE WINDOW を使う画面を開き、F3 等で窓を閉じたとき、窓の枠が
     呼び出し元の画面に残らないこと（今回追加で見つけた不具合）。
   - c) COLOR(YLW) や COLOR(TRQ) を使うフィールド（DSPATR(RI) 反転併用も含む）で、フィールドの頭に
     意図しない縦棒（桁区切り）が出ないこと。逆に、他の色（緑・赤等）で DSPATR(CS) を明示的に
     指定したフィールドの桁区切りは今までどおり表示されること（退行していないことの確認）。
   - d) 「応答待ちのまま固まる」不具合が起きていた画面で、操作後に応答がすぐ返ってくること。
   - e) 「スプール・ファイルの表示」（DSPSPLF 系）で、見出し行より後ろのサブファイル明細データ
     （部品コード・数量等）が最後まで表示され、ACS の表示と一致すること
     （`"仕*"` のように、末尾の `"*"` まで含めて一致するか確認）。
   - f) 上記 e) を Web UI の「カナ表示モード」と「英表示モード」の**両方**で確認すること。
     `"*"` がどちらのモードでも化けずに表示されること（片方のモードだけで確認すると見落とす）。
   - g) 日本語のエラーメッセージが出る操作（例: 使用できないファンクションキーを押す等）を行い、
     画面下部のエラー行が文字化けせず正しく表示されること（修正I）。

---

# 文書2: 新規セッション追加で「system XXX not found」（修正J）

## 症状

「セッションを追加」で、親システムが**サーバー設定**（管理者が全員向けに登録したシステム）のものを選ぶと、
保存時に `system DEVSVR1 not found` というエラーになる。親システムが「自分の設定」のものなら再現しない。

## 原因

`packages/web-ui/src/components/ConfigCard.vue` の `isServer` computed が、
新規セッション作成時に**常に「自分の設定」扱い**になっていた。

```ts
// 修正前
const isServer = computed(() => {
  const r = props.system?.ref ?? props.session?.ref;
  return r ? r.startsWith("srv:") : source.value === "server";
});
```

- `props.system` はシステムカード用の prop なので、セッションカードでは常に `undefined`。
- `props.session` は「新規作成中」は実体がまだ無いので `undefined`。
- 結果、新規セッションでは必ず `source.value === "server"` にフォールバックする。
  しかし `source`（保管場所の select）は**システム作成フォームにしか存在しない**
  （`kind === 'system'` の場合だけ描画される）ため、セッション作成時は常に既定値 `"personal"` のまま
  → `isServer.value` が常に `false` になっていた。

`save()` はこの `isServer.value` を使って送信する `source` を決めている
（`form.source = isServer.value ? "server" : "personal"`）。

一方サーバー側 `packages/server/src/config-store.ts` の設計では、
**セッションは自分の参照先システムと同じ保管場所（ファイル）にしか置けない**
（`assertIntegrity` / `addSession` 内 `this.getSystem(s.system)` のコメント参照）。

つまり:
1. 親システムが `srv:DEVSVR1`（サーバー設定）でも
2. UI は常に `source: "personal"` で POST し
3. サーバーは個人設定ストア（`connections.json`）に `addSession` しようとし
4. そのストアには `DEVSVR1` というシステムが存在しない（サーバー設定側にしかない）
5. `getSystem("DEVSVR1")` が `SESSION_NOT_FOUND`（`system DEVSVR1 not found`）を投げる

## 修正

`isServer` を、セッションの場合は「選んだ親システムの参照（`srv:` / `own:`）」から判定するように変更する。
既存セッション編集時は `props.session.ref` を使い、新規作成時はフォームの `sesForm.system`
（親システム参照。作成カードは `parentSystem` prop から初期化される）を使う。

### 変更ファイル

- `packages/web-ui/src/components/ConfigCard.vue`
- `packages/web-ui/test/config-card-ownership.test.ts`（再現テストを追加）

### diff

```
@@ -104,10 +104,23 @@ const wmForm = reactive({
 /** 透かしの文字に使える差し込み変数（`{host}` 等）の説明 */
 const WM_VAR_HINT = WATERMARK_VARS.map((v) => `{${v.key}}=${v.label}`).join(" / ");

-/** 編集対象がサーバー設定か（信頼設定の欄を出すかの判定に使う） */
+/**
+ * 編集対象がサーバー設定か（信頼設定の欄を出す・保存先を選ぶ判定に使う）。
+ *
+ * セッションは**選んだ親システムと同じ保管場所**にしか置けない（config-store のスコープ規定）。
+ * 新規セッションには `props.session` がまだ無いので、`props.system?.ref ?? props.session?.ref`
+ * では常に未定義に落ちて `source.value`（システム作成用の select。セッションには無い）を見てしまい、
+ * 常に「自分の設定」を選んだのと同じ扱いになっていた――親がサーバー設定のシステムだと、
+ * セッションは個人設定ファイルに追加されて `system ... not found` になる。
+ * 新規作成中は `sesForm.system`（フォームで選んだ親システムの参照）で判定する。
+ */
 const isServer = computed(() => {
-  const r = props.system?.ref ?? props.session?.ref;
-  return r ? r.startsWith("srv:") : source.value === "server";
+  if (props.kind === "system") {
+    const r = props.system?.ref;
+    return r ? r.startsWith("srv:") : source.value === "server";
+  }
+  const r = props.session?.ref ?? sesForm.system;
+  return r?.startsWith("srv:") ?? false;
 });
 /**
  * この設定を編集できるか。**サーバー設定は編集権限があるときだけ**――
```

（テストの追加分は同梱の diff ファイル参照 → **その diff ファイルは PDF に含まれていない**。
再現テストは下記「再現手順」から書き起こす必要がある。）

## 動作確認（原典の実績）

- `packages/web-ui` で `npx vitest run test/config-card-ownership.test.ts`
  → 12 件全て pass（修正前に戻すと再現テスト 1 件が fail することを確認済み）
- `npx vitest run`（web-ui 全体、974 件）→ 全て pass
- `npx vue-tsc --noEmit -p tsconfig.json` → エラーなし

## 再現手順（この修正が要る/効いていることの確認）

1. 「システムを追加」で「保管場所」を「サーバー設定（全員が使える）」にしてシステムを 1 つ作る
   （admin 権限 = `systemsStore.editable` が必要）
2. そのシステムを選択し、「セッションを追加」で名前などを入れて保存
3. 修正前: 「system <名前> not found」で保存に失敗する
4. 修正後: 正常に保存できる
