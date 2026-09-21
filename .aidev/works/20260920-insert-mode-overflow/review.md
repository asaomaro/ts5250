# レビュー: 挿入モードで欄が満杯のとき、黙って文字を捨てない

## ラウンド 1（差し戻し）

実装差分（`packages/web-ui/src`）を独立コンテキストに点検させた。**must 3 件**。
うち 1 件は**この work の目的そのものを裏切る**もので、自分でも再現を確認した。

- [must][conv:test-input-shape!] `packages/web-ui/src/composables/fieldEdit.ts:55,60`
  `typeChar` が**空きを数えた位置と違う位置から捨てている**。`trailingRoom` は
  `chars.length-1-reserved` から数え始めるのに、捨てるのは常に `chars.length-1`。
  取り置き桁が**非空白**（符号桁に `-` が入った通常の符号付き数値欄）だと `isBlankCell` で
  即 break し、1 桁も捨てずに配列が欄長+1 に伸びる。伸びた値は `fitsBytes` が落とすので、
  結果は「**空きが 4 桁あるのに `MSG_NO_ROOM` で 1 桁も打てない**」。
  再現: 欄長 6・`"1    -"`・cursor=1 に `9` → `{ value: "19    -", len: 7 }`（期待 `"19   -"` / 6）。
  / 対応: 捨てる位置を `chars.length-1-(opts.reserved ?? 0)` にする。
  **`[conv:test-input-shape!]` の理由**: `tasks.md` の形の表で「符号桁が最終桁」を **T12（純関数）
  にしか割り当てていなかった**。`typeChar` の層（T13）に同じ形を振っていれば、この穴は
  テストで塞がっていた。**AC11c も `trailingRoom` しか見ていない。**

- [must][conv:-] `packages/web-ui/src/components/ScreenGrid.vue:2076`（影響 2889-2894）
  `dbcsType` の取り置きが**上書きモードにも掛かっている**（退行）。`budget` を無条件に減らすため、
  バイト予算いっぱいの DBCS 専用欄は**上書き（5250 の既定）でも拒否**される。
  さらに選択置換の経路では `deleteSelection` が先に `edit` を書き換えてから拒否するので、
  **選択が消えたままモデルだけ変わって DOM と食い違う**。SBCS 側は「選択を消した分の空きが
  あるので検査しない」と明記して避けているのに、DBCS 側だけ同じ穴が残っている。
  / 対応: 取り置きを挿入モードのときだけ効かせる。選択置換の経路は SBCS 側と同じく検査しない。

- [must][conv:-] `packages/web-ui/src/components/ScreenGrid.vue:3145`
  `insertInto` が取り置きを**予算から引いている**——design が「やってはいけない」と書いた
  引き算そのもの。`out` は末尾空白しか落とさないので**符号桁の `-` は残ったまま**予算だけ減り、
  二重に数える。欄長 6・`"1    -"`（空き 4 桁）へ 1 文字貼り付けても拒否される。
  退行ではない（変更前も拒否）が、**目的の場面で直っていない**うえ、
  打鍵（開始位置ずらし）とペースト（引き算）で空きの数え方が割れている。
  AC4 のテストは**符号桁が空白の欄しか見ていない**ので通ってしまう。
  / 対応: 取り置きの意味を揃える（符号桁が既に埋まっているなら追加の取り置きは要らない）。

- [should][conv:-] `packages/web-ui/src/components/ScreenGrid.vue:3481-3486`
  **IME 確定だけ「余地が無い」を検知できていない。** `typeChar` は拒否時に同じ state を返すので
  `!trial` は偽、`fitsBytes` も真 → notice を出さず break もせず、以降の確定文字も黙って落ちる。
  他の 3 経路は `MSG_NO_ROOM` が出るので**経路で規則が割れている**（AC4 の趣旨に反する）。
  / 対応: `canInsert` を前置するか `trial === e` を見る。

- [should][conv:-] `packages/web-ui/src/components/ScreenGrid.vue:3480-3481`
  同じ行で `base` が DBCS 側にしか渡っていない（`decisions.md` D10 で「範囲外」としたもの）。
  ただし**取り置きを足すために触っている行**であり、新しい空き判定がどの state を見るかも
  同時に決めている。/ 対応: D10 の判断を見直すか、少なくともこの行で何を見るか明記する。

- [should][conv:-] `packages/web-ui/src/components/ScreenGrid.vue:1707,1713`
  **既に 1 か所に閉じてある定義を書き下している。** `"only" | "pure"` は `isDbcsOnly`
  （`@ts5250/tn5250/browser` 公開。`fieldValidate.ts:2` で既に import 済みで、原典の JSDoc に
  「web-ui の打鍵時検査も同じ判定を使う」と明記）を使うべき。`isFullWidth(ch) ? 2 : 1` も
  同ファイルの `displayCols`（`:1023`「桁数の定義をここ 1 箇所に閉じ込める」）と重複で、
  素の `isFullWidth` は**生センチネルを 2 桁と数える**危険がある。
  / 対応: `isDbcsOnly` と `displayCols` を使う。

- [nit][conv:-] `fieldEdit.ts:249,258` `reservedTail` の doc が DBCS を「さらに 1 桁ぶんずらす」と
  書くのに返すのは 2。同じ doc が単位を畳んでいるので読み手の中で衝突する。
  / 対応: 「全角 1 文字＝2 桁」と書く。

- [nit][conv:-] `fieldEdit.ts:234` `paste()` だけ既定値のまま `typeChar` を呼ぶ。挙動は今回の変更で
  変わっており（満杯だと無言で何もせず残りも素通り）、次に使う人向けの罠。
  / 対応: 撤去するか opts を通すかを決める（台帳起票済みだが、罠の性質が変わった）。

- [nit][conv:-] `ScreenGrid.vue:2790,2893` `MSG_NO_ROOM`（「挿入する余地がありません」）を
  **上書きモードの拒否にも出している**。挿入していないのに「挿入する余地が」と言うことになる。
  / 対応: must 2 を直すと 2893 は解消。2790（バイト予算超過）は文言の当て方を検討する。

### このラウンドの総括

**`verify-by-mutation` は通っていたのに欠陥が残った。** mutation 5 か所すべてで落ちる状態を
作ったうえで、**その 5 か所のどれでもない場所**（捨てる位置）に欠陥があった。
mutation は「**書いたテストが効いているか**」を測る道具であって、
「**テストが十分か**」は測らない——今回の穴は `tasks.md` の形の表で
「符号桁が最終桁」を純関数の層にしか割り当てなかったことに由来する。

## ラウンド 2（差し戻し）

ラウンド 1 の指摘への対応を同じ観点で再点検させた。**must 2 件・nit 2 件。**
ラウンド 1 の must 1 / must 3 / should 4 / should 5 は**正しく直っていると確認された**
（`"123   -"`/cursor=3 → `"123X  -"` len=7 の実測、`insertInto` の二重計上解消、
`canInsert` / `isDbcsOnly` / `displayCols` の採用、境界は全て安全側）。

- [must][conv:paired-artifact-sync!] `packages/web-ui/src/components/ScreenGrid.vue:3519`
  **ラウンド 1 の must 2 と同一の形が IME 経路に残っていた。** `onCompositionEnd` の DBCS 分岐だけ
  `dbcsType` の第 4 引数を渡しておらず、既定の `reserve = e.insertMode` が効く。
  `base` は選択置換のとき `insertMode: true` に差し替えられるので、
  **上書きモードの利用者にも取り置きが掛かる**。`only`/`pure` 欄では予算が変更前より 2 バイト狭くなり、
  以前は入っていた IME 選択置換が `MSG_NO_ROOM` で落ちる（**退行**）。
  兄弟の打鍵経路（`:2904`）は同じ理由で `replaced ? false : base.insertMode` を渡している。
  / 対応: IME 側も明示的に渡す。
  **`[conv:paired-artifact-sync!]` の理由**: 対になる 2 経路（打鍵と IME）の片方だけを直した。
  **前 work で 3 ラウンドかけて学んだ「呼ぶ位置まで揃える」を、この work でまた踏んだ。**

- [must][conv:-] `packages/web-ui/src/components/ScreenGrid.vue:2899-2909`
  **ラウンド 1 の must 2 のうち「モデルと DOM が食い違う」側は塞がっていない。**
  私が書いたコメントは「選択を消した分の空きが必ずできる」と断言しているが、
  **これは事実として誤り**——SBCS 1 バイトを消して全角を挿すと SO/SI 込みで最大 +4 バイトになり、
  満杯欄では `absorbDbcs` が `undefined` を返しうる。その場合 `syncDbcs` を呼ばずに `return` するので、
  `deleteSelection` が既に書き換えた `edit`（選択が消えた状態）と DOM（選択が残った表示）がずれ、
  **次の打鍵・カーソル移動で文字が勝手に消える**。
  / 対応: 拒否時は削除前の `edit` へ戻す（または `syncDbcs` する）。**コメントの事実主張も直す。**

- [nit][conv:-] `packages/web-ui/src/composables/fieldEdit.ts:58-68`
  `typeChar` は `need=2` のとき 1 要素挿入して 2 要素捨てるので `chars.length` が欄長より 1 短くなり、
  `EditState` の不変条件（`:9`）が崩れる。到達経路は `hidden` かつ `dbcsType` を持つ欄の打鍵だけで狭いが、
  **防いでいるのは偶然であって明示的な不変条件ではない**。`decisions.md` D9 の
  「満杯判定が 1 桁早まるだけ」も不正確（`writeSlices` と `moveCursor` のクランプにも効く）。
  / 対応: 不変条件を型コメントに正しく書き直し、D9 を訂正する。

- [nit][conv:-] `packages/web-ui/src/components/ScreenGrid.vue:2905-2909`
  `!trial` は**上書きモードでも成立する**のに「挿入する余地がありません」を出す。
  挿入していない利用者に挿入の文言が出る（従来は無言だったので新たに見えるようになった差分）。
  / 対応: 通知を挿入モードに限る。

### このラウンドの総括

**ラウンド 1 で「4 経路に一貫して効いているか」を観点に挙げて点検させたのに、
IME 経路の取り置きだけが 2 ラウンド続けて漏れた。**
1 度目は「既定値のまま呼んでいた」、2 度目は「第 4 引数を渡し忘れた」——
**同じ経路が、違う理由で 2 回漏れている。**
条項 `paired-artifact-sync` が言う「片方だけ直す」の典型で、
前 work（`20260920-field-error-no-value`）が 3 ラウンドかけて学んだことと同じ。

## ラウンド 3（差し戻し）

**must は 0 件。** ラウンド 1 / 2 の指摘 1〜8 はすべて直っていると確認された。
不変条件「取り置きは挿入モードのときだけ効く」が**6 経路すべてで一貫している**ことも、
打鍵 SBCS / 打鍵 DBCS / ペースト SBCS / ペースト DBCS / IME SBCS / IME DBCS の
個別確認つきで追認された。`insertInto` の符号桁保全と DBCS の予算減算の使い分けも
二重計上が無いと確認された。

- [should][conv:paired-artifact-sync!] `packages/web-ui/src/components/ScreenGrid.vue:3550`（および `:2814`）
  **ラウンド 2 の nit 9（上書きモードに「挿入する余地がありません」を出さない）が、
  また対の片方にしか当たっていない。** `onDbcsKeydown`（`:2929`）は `if (base.insertMode)` で
  塞いだが、**IME 経路（`:3550`）と SBCS 打鍵の `fitsBytes` 失敗（`:2814`）は無条件**。
  同じ操作を打鍵ですると無言、IME だと通知、と**兄弟経路で答えが割れている**。
  / 対応: 両方をゲートし、**さらに走査テストで「無条件 emit を置けない」ことを固定する**。
  **`[conv:paired-artifact-sync!]` の理由**: 同じ不変条件の片方だけを直すのが
  **この work で 4 回目**（既定値 → 引数渡し忘れ → SBCS の状態戻し → 今回の通知ゲート）。
  **散文の注意書きでは止まっていない**ので、機械で止める層へ降ろす。

- [should][conv:-] `packages/web-ui/src/composables/fieldEdit.ts:244-252`
  `fieldEdit.paste()` が `typeChar` を `opts` 無しで呼ぶ**唯一残った経路**で、
  **doc も事実と食い違う**——「超過は切り詰め」は挿入モードではもう正しくない
  （空き不足なら値を変えず、最終桁では拒否する）。本番の呼び出し元は無いが、
  **不変条件を素通しする公開関数が残っている＝次に漏れる口**。
  / 対応: `opts` を通し、doc を実態に合わせる。

- [nit][conv:-] `packages/web-ui/src/components/ScreenGrid.vue:2531`（`fieldEdit.ts:88-104` も同形）
  **既存の欠陥**（この差分の混入ではない）。`deleteSelection` は選択を `splice` して末尾に空白を足すので、
  符号付き数値欄の**符号桁が選択長ぶん左へずれる**（`"123  -"` の `123` を選んで `X` → `"X  -"`）。
  `backspace` / `del` も同形。本 work の目的（符号桁を守る）の真横にあるが、
  **原因も対象も別**（選択削除の詰め方）。
  / 対応: **この work では直さず台帳へ**。ACS の挙動を実機で測ってから直す。

### このラウンドの総括

**must が 0 になった一方で、「対の片方だけ直す」が 4 回目**。
1 回目〜3 回目はいずれも「次は気をつける」で済ませてきたが、**それでは止まっていない**。
`protocol.md`「12.」の表が言う「規約はあるのに守られていない ＝ 層を下げる」に該当するので、
**走査テストで機械的に止める**側へ倒す（`dbcs-reserve-call-sites.test.ts` と同じ手）。

## ラウンド 4（差し戻し）

- [must][conv:paired-artifact-sync!] `packages/web-ui/src/components/ScreenGrid.vue:3551-3558`（削除は `:3483`）
  **`onCompositionEnd` が拒否するとき、合成開始で消した選択を戻さずそのまま確定する。**
  ラウンド 2 の must（`onDbcsKeydown`）・D12（SBCS 打鍵）で 2 度塞いだのと**同一の形**。
  しかもこれまでより悪く、`edit = e` が**選択を消した状態を確定して `emit("edit")` まで出す**
  ——MDT が立ち、**送信値が 1 文字欠ける**。上書きモードなので通知も出ない。
  実測: `dbcsType:"open"`・欄長 10・`"ABCDEFGH"`・上書き・`"A"` を選択して IME で `全` を確定
  → `"BCDEFGH"` が emit される。続けて `X` を打つと `"XBCDEFGH"` ではなく `"XCDEFGH"`。
  / 対応: **構造で閉じる**（下記）。
  **D12 に書いた「同じ観点で全経路を洗った」は事実として誤りだった。**
  `deleteSelection` の呼び出し箇所は数えたが、**合成開始で消して合成終了で確定する**という
  時間をまたぐ経路を「最後に `sync` するから安全」と誤読していた。

- [should][conv:paired-artifact-sync!] `packages/web-ui/src/components/ScreenGrid.vue:2931`
  **通知のゲートが `onDbcsKeydown` だけ別の述語**。`base.insertMode` は選択置換のとき
  **利用者のモードに関わらず true** になるので、上書きでも通知が出る。
  ラウンド 3 で `:2814` / `:3550` を「`:2929` に揃えよ」と書いたが、実際に入った修正は
  **利用者の実モード**（`edit.insertMode` / `e.insertMode`）で、**揃え先のほうが間違っていた**。
  3 経路で述語が 2 種類になっている。
  あわせて `:2815` と `:3552` の「兄弟経路と同じく」というコメントは**事実として誤り**。
  / 対応: 利用者の実モードに統一する。

### このラウンドの総括——**個別に塞ぐのをやめる**

**同じ不変条件の漏れが 5 回目**（既定値 → 引数渡し忘れ → SBCS の状態戻し → 通知ゲート →
IME の状態戻し）。**4 回続けて「次は全経路を洗う」と書き、4 回とも洗い漏らした。**
散文の注意書きでも、私の目視による列挙でも止まっていない。

→ **拒否の出口を 1 つの関数に集約する**（`rejectInput`）。
状態を戻すことと、通知を利用者の実モードに限ることを**呼ぶ側が覚えなくてよい形**にする。
`protocol.md`「12.」の「規約はあるのに守られていない ＝ 層を下げる」をコード構造で実施する。

## ラウンド 5（差し戻し）

- [must] `ScreenGrid.vue:3572-3575` IME の `canInsert` 事前検査だけ `rejectInput` を経由せず、
  `rejected` を立てずに `break` していた。消した選択がそのまま確定し**送信値が 1 文字欠ける**。
  `rejectInput` の「唯一の出口」という断言も**事実ではなかった**（誤った断言 4 回目）。
  / 対応: 事前検査を撤去し、判定を `typeChar` の戻り値 1 本（同一参照＝拒否）に寄せた。
- [should] 同じゲートが `composeReplacedSelection` を見ず、選択置換でも取り置き・最終桁を検査して
  打鍵側と割れていた。/ 対応: 選択置換の 1 文字目は検査を外し、打鍵側と揃えた。

## ラウンド 6（差し戻し）

- [must][conv:-] `ScreenGrid.vue:3516-3517`（唯一の代入）/ `:3612-3616`（stale な控えで restore）
  **IME の合成状態（`composeReplacedSelection` / `composeBeforeDelete`）が合成の終わりで消えない。**
  次の `compositionend` が**前の合成（別の欄のこともある）の控え**で restore を踏み、
  **その欄へ他欄の値が書き込まれて `emit("edit")` で送信される**（MDT も立つ）。
  `onCompositionStart` は `inhibited` で早期 return するが `onCompositionEnd` には門が無いので、
  **ホスト応答待ち中に日本語入力を始め、応答後に確定する**という通常操作で成立する。
  再現: 欄1で選択置換の合成 → busy 中に欄2で合成開始 → 解除後に確定文字 0 個で確定
  → `edit` の emit が `[[1,"XDEFGH"],[2,"ABCDEFGH"]]`。
  **これは私がラウンド 4/5 で入れた `composeBeforeDelete` の復元が作り込んだ欠陥**で、
  元の不具合（1 文字欠ける）より重い（**他欄の値が混入する**）。
  / 対応: 全出口で両フラグを初期化し、restore は `editFieldIndex === f.index` を確かめる。

- [should][conv:-] `ScreenGrid.vue:3554-3560` と `:1719`
  ラウンド 6 の待ち時間に**私が自分で足した** `protected` / `hidden` の枝が
  **`rejectInput` を通さずに `edit` を戻している**ので、「唯一の出口」という断言が**また**成立していない
  （**誤った断言 5 回目**。しかも自分で塞いだ直後に自分で破った）。
  DOM を作り直さず、欄の一致も確かめていない。
  / 対応: `rejectInput` に寄せる。

- [nit][conv:-] `ScreenGrid.vue:2836` `:1751` / `fieldEdit.ts:54-65`
  ラウンド 5 で IME から撤去した `canInsert` の事前検査が**打鍵経路には残っている**。
  述語が 2 か所にあり、`typeChar` 側だけに拒否条件が増えると
  **打鍵が通知を出さず無変化で確定**する。/ 対応: IME と同じく戻り値 1 本に寄せる。

### このラウンドの総括——**修正が新しい欠陥を作った**

6 回目にして、**私の修正そのものが、元より重い欠陥を作り込んだ**（他欄の値の混入）。
「同じ不変条件を落とす」段階から「**直そうとして壊す**」段階に移っている。
IME 経路は**合成開始と合成終了が時間をまたぎ、状態がモジュール変数に残る**構造で、
その寿命管理を私は一度も正しく扱えていない。
**個別の修正を積むのをやめ、寿命そのものを明示的に管理する形にする。**

## ラウンド 7（スコープ縮小後・差し戻し）

must 1・nit 4。**縮小の取りこぼしは 0 件**と確認された
（`composeUndo` / `takeComposeUndo` / `canInsert` / `resync` の実参照なし）。

- [must][conv:-] `ScreenGrid.vue:2831`
  **上書きモードで欄末尾に止まっているときの退行。** `typeChar` は `cursor >= chars.length` で
  **モードに関係なく同一参照を返す**（`fieldEdit.ts:55`）のに、`t === edit` の枝が
  `userInsertMode: true` を決め打ちするため、**上書き中でも「挿入する余地がありません」が出て**、
  さらに HEAD なら走っていた `advanceIfFull`（`field-full`）が出なくなる。
  design「上書きモードは一切変えない」にも反する。
  実測: 5 桁満杯欄で caret を末尾に置き `X` を打鍵 → ins/FER の 4 通りすべてで通知が出て
  `field-full` が 1 度も出ない（HEAD は非 FER で `field-full`）。
  到達は End/→ で満杯欄の末尾に止まる・FER 欄を埋め切った後の続打鍵——**どちらも通常操作**。
  **`canInsert` を撤去して同一参照判定へ寄せたときに、私が作った退行。**
  / 対応: `userInsertMode: edit.insertMode` を渡し、同一参照を拒否とみなすのは
  `cursor < chars.length` のときだけにする（末尾は HEAD どおり `advanceIfFull` まで落とす）。

- [nit] `ScreenGrid.vue:1721` `rejectInput` の doc「採否は戻り値**1 本**」は言い過ぎ
  ——`fitsBytes` が第 2 の述語として同じ出口を呼ぶ。「出口は 1 つ」は事実。
- [nit] `ScreenGrid.vue:1701` `roomOptsOf` の doc が either の損得を「1 桁」と書くが、
  DBCS の取り置きは **2 桁**。
- [nit] `ScreenGrid.vue:3570` IME の「2 文字目以降は普通の挿入」は SBCS では成り立たない
  （`e.insertMode` は利用者の実モードなので上書き中は上書き）。
- [nit] `fieldEdit.ts:13` `EditState.chars` の doc——`need=2` が起きるのは **SBCS 経路**
  （DBCS 欄は `dbcsType` を通り `typeChar` に来ない）。「バイト数が保たれる」も
  SO/SI 込みでは新しい DBCS ランで保たれない（実害は `fitsBytes` が止める）。

## ラウンド 8（通過）

**must 0・should 0・nit 5。** プロトコル上は nit のみで通過だが、5 件のうち
**記録と実装の食い違い**と**未使用 import** は deliver 前に直した。

- [nit] `ScreenGrid.vue:22` `trailingRoom` の import が未使用（使うのは `typeChar` の中だけ）。
  vue-tsc も eslint も落とさない。/ 対応: 撤去。
- [nit] `rejectInput` / `roomOptsOf` の doc が `fitsBytes` を述語として挙げるが、
  **DBCS 打鍵経路は `fitsBytes` を呼ばない**（述語は `dbcsType` の戻り値）。
  / 対応: 経路ごとに述語を書き分けた。
- [nit] IME の「2 文字目以降は利用者のモードどおり」は **SBCS 枝だけ**の話。
  DBCS 枝は `base` が `insertMode: true` のままなので挿入が続く。/ 対応: 枝ごとに書き分けた。
- [nit] ラウンド 7 で打鍵に入れた「欄末尾は拒否ではない」の区別が **IME 側に入っていなかった**
  （**同じ不変条件を片側だけ直した形**がまた残っていた）。/ 対応: IME にも同じ区別を入れた。
- [nit] `EditState.chars` の doc が `decisions.md` D9 / D11 と**逆**になっていた。
  / 対応: **D9 / D11 の事実主張を取り消した**（`AGENTS.md`「過去の決定を疑い、破棄する」）。
  D11 の書き換え案は 2 点で誤り——`need=2` は DBCS 欄ではなく **SBCS 経路**で起きる／
  SO/SI 込みでは**バイト数も保たれない**。

観点 1（ラウンド 7 の must の修正）は**退行なし**と確認された
（`typeChar` が同一参照を返す 3 通りを列挙し、上書き × `cursor < len` では必ず新オブジェクトを
返すので、区別が正しく効いている）。観点 3 も must/should 相当は検出されず。

### この work のレビュー総括

**差し戻し 7 回・同一不変条件の漏れ 8 回**（最後の 1 回はこのラウンドの nit）。
漏れはすべて「**対になる経路の片方だけを直す**」形で、
散文の注意書き・目視の列挙・`rejectInput` への集約でも完全には止まらなかった。
最終的に止まったのは、**採否の述語を戻り値 1 本に寄せ、事前検査を撤去した**こと
（出口が構造的に 1 つになった）。
