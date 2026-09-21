# 調査: 挿入モードで欄が満杯のときの ACS の規則

**原典を直接読んだ**（`AGENTS.md` 判断の原則 1）。台帳の要約は**一部が誤っていた**ので、
原則 3 に従って破棄する（F5）。

手順: `IBMiAccess_v1r1/acsbundle.jar` → 入れ子 jar `plugins/emulator/acshod2.jar` を展開 →
CFR 0.152 で `com/ibm/eNetwork/ECL/tn5250/PS5250.class` をデコンパイル（scratchpad。
**成果物はリポジトリに入れていない**）。以下の行番号は**そのデコンパイル結果**のもので、
ACS の版が変われば動く。**引用はせず、事実として書き起こしている**。

## 調査の問い

- Q1: `reserveRoomForInsert` は空きをどう数えるか（最終桁から？ 欄のどこかの空白も数える？）
- Q2: 符号付き数値欄で符号桁はどう扱うか
- Q3: 余地が無いときに ACS は何をするか（エラー 0012 を出す？ 値は？ 利用者への合図は？）
- Q4: 継続欄（複数行の欄）ではどう数えるか
- Q5: 当 PJ 側のあふれの経路はいくつあるか

## 判明した事実

### F1: 空きは「**末尾の連続した空白**」だけを数える（Q1）

`PS5250.reserveRoomForInsert(field, n, n2, n3)`
（`n`＝走査開始位置＝欄の最終桁、`n2`＝要る桁数、`n3`＝カーソル位置）は、
**`n` からカーソルの手前へ 1 桁ずつ戻りながら空白を数え、最初の非空白で打ち切る**。

- 空白とみなすのは **`\0` / 半角空白 / 全角空白（U+3000）**。
  DBCS セッションでは DBCS 面が `' '` か `0x10` の桁を空白から除く。
- 数えた数 `n5` が要る桁数 `n2` に満たなければ **`false`**（何も動かさない）。
- 足りれば、`n2` 桁ぶん右へシフトする（Text / Host / Field / Exfield / Color / ColorAttributes /
  Update、DBCS セッションなら DBCS 面も一緒に動かす）。

**「欄のどこかに空白があるか」ではない。** これは実装の分かれ目になる——
`"AB  C "`（6 桁・末尾 1 桁だけ空き・中間に 2 桁の空白）の空きは **1** であって 3 ではない。
requirements の AC11 はこの形を突くためにある。

### F2: カーソルが最終桁にあるときは即座に拒否（Q1）

`if (n3 == field.getEndPos()) return false;` ——空きを数えるより前に落とす。
当 PJ の `typeChar` が `cursor >= len` で早期 return するのと**向きは同じ**
（`fieldEdit.ts:31`）。

### F3: 符号桁は走査開始位置を 1 つ手前にずらして取り置く（Q2）

`reserveRoomForInsert` の中ではなく、**呼び出し側の `PS5250.insertChar` が調整する**:

- `if (field.isSignedNumericField()) --n3;`（`n3` はこの文脈では `getEndPos()`）
- さらに `if (field.isDBCSOnlyField() || (field.isDBCSEitherField() && field.isEitherFieldDBCSOn())) --n3;`
  ——**DBCS 専用／either が DBCS 側のときも 1 桁取り置く**。台帳はこちらに触れていない。

その調整後の値を `n6` として `reserveRoomForInsert(field, n6, n5, cursorSBA)` に渡す。
**つまり「符号桁の手前から数える」は正しい**が、**符号桁だけではない**。

### F4: 余地が無いとき、ACS は**値を変えず・エラーコードを出さず・音を鳴らす**（Q3）

通常の打鍵経路を追うと:

1. `reserveRoomForInsert` が `false`
2. → `insertChar` が `-2147483630`（`Integer.MIN_VALUE + 18`）を返す
3. → 呼び出し元 `processCharKeyStroke` の `else { bl = false; }` に落ちる
   ——**`setErrorCode` は呼ばれない**
4. → `keyDown` 側で `if (processCharKeyStroke(n)) keyProcessed = true;` なので
   **`keyProcessed` が立たない**
5. → ACS パッケージでは
   `Sounds.play(session, keyProcessed || (bl2 && !error_mode) ? 2 : 1)`
   ——**処理されなかった側の音（1）が鳴る**

**操作員エラーの表示も、メッセージも出ない。音だけ。** 値は 1 文字も変わらない。

### F5: **台帳の「エラー 0012 を出す」は誤り**（Q3。原則 3 で破棄）

`setErrorCode((short)18)`（18 = 0x12 → 表示は `0012`）は `PS5250` に**ちょうど 1 か所**あり、
それは **`processGenSOSI()`**（SO/SI を挿し込む経路）で、
`reserveRoomForInsert(field, n2, 2, cursorSBA)` が失敗したときに出す。
**通常の文字入力（`insertChar`）の経路ではない。**

- 台帳 `.aidev/backlog/acs-parity.md:110` の
  「足りなければエラー 0012 を出し、値を変えない」は、
  **「値を変えない」は正しいが「0012 を出す」は通常の打鍵では起きない**。
- 同じ台帳が**番号の取り違えの前例**（`:265`）を記録しており、requirements でも
  「番号は要確認」としていた。**確認したら実際に違った。**
- なお `PS5250` が使う操作員エラーは 4/5/6/7/18/20/21/22/24/25/32/33/35/39/101/114。

### F6: 継続欄は**チェーン全体の予算**で数える（Q4）

`reserveRoomForInsert` は冒頭で
`if (field.isContField()) return reserveRoomForContField(field, n, n2, n3);` と丸ごと委譲する。

`reserveRoomForContField` は `fft.getContFieldChain(field)` で得た連結欄の列を
**最後の segment から先頭へ向かって走査**し、各 segment の末尾から空白を数えて `n8` に積む。
**判定は `if (n8 < n2) return false;`** ——**チェーン全体の合計**で見る。
足りればシフトも segment をまたいで波及させる（`n11 - n7 < n3` で打ち切り）。

- **台帳の「欄全体の予算を見ているかを確かめれば `AGENTS.md` の残課題を閉じられる見込み（推測）」は当たり**。
  ACS は**欄全体（チェーン全体）**で数える。
- 冒頭に `if (n3 == chain の最後の segment の getEndPos()) return false;` もある（F2 の継続欄版）。

### F7: 当 PJ のあふれの経路は 4 つあり、ACS と一致しているのは 0 個（Q5）

| 経路 | 場所 | いまの挙動 | ACS（F1〜F4）と比べて |
|---|---|---|---|
| 打鍵（挿入） | `fieldEdit.ts:29-43`（`chars.length = len`） | **末尾を切り詰める** | ❌ 値が変わる |
| `fieldEdit.paste()` | `fieldEdit.ts:202-210` | `typeChar` を回すので**切り詰める** | ❌ 同上 |
| 貼り付け（挿入） | `ScreenGrid.vue:3231-3251`（`pasteFrom`→`insertInto`） | 何も書かず `MSG_NO_ROOM` | ⭕ 値は守る / ❗ ACS は**音だけ**でメッセージは出さない |
| DBCS 打鍵 | `ScreenGrid.vue:2000-2007` `absorbDbcs` / `:2844-2845` | 値は変えないが**通知も出さない** | ⭕ 値は守る（音の有無は未確認） |

**「空きの数え方」はどの経路も ACS と違う。** `insertInto`（`:3090-3103`）は
base の末尾空白を落として `dbcsByteLength(out) > visLen` で見るだけで、
**符号桁も DBCS 桁も取り置かない**（F3 の調整が無い）。

~~当 PJ の `EditState.chars` は**常に欄長ぶん空白で埋められている**（`padTo`。`fieldEdit.ts:212-216`）~~
→ **誤り**（doccheck ラウンド 1）。**SBCS 欄だけ**そうで、**DBCS 欄では `padDbcs`
（`ScreenGrid.vue:1989-1997`）が「バイト予算」まで詰める**ので `chars.length < visLen(f)`。
**桁（配列要素）とバイトは別の単位**で、`dbcsByteLength` は孤立した全角を SO+2+SI＝4 バイトで数える。

## 影響範囲

- `packages/web-ui/src/composables/fieldEdit.ts` — `typeChar` / `paste`
- `packages/web-ui/src/components/ScreenGrid.vue` — `insertInto`（符号桁・DBCS 桁の取り置き）、
  DBCS 打鍵と IME 確定の通知
- `packages/web-ui/src/composables/opMessages.ts` — 通知をどうするか（下記の申し送り）
- `packages/web-ui/test/field-edit.test.ts` — 満杯の挿入を見ていない

## 実現性 / リスク

- **F1 の「末尾の連続空白」はそのまま書ける**（当 PJ は常に空白パディング）。リスクは低い。
- **F3 の取り置きは条件が 2 つ**（signedNumeric / DBCS-only・either-on）。
  当 PJ の `Field` 型にこの 2 つが揃っているかを coding 前に確かめること
  （`signedNumeric` はある——`fieldValidate.ts:334-336` の `isSignPosition` が使っている）。
- ~~**継続欄（F6）は当 PJ 側の欄モデルがチェーンを持っているか**が鍵。`fieldSlices.ts` が…~~
  → **対応物を取り違えていた**（doccheck ラウンド 1）。`fieldSlices` は**1 つの欄の行折返し**。
  チェーンに当たるのは `Field.continued`（`packages/tn5250/src/screen/types.ts:45,161`）＋
  `continuedRunOf`（`packages/web-ui/src/composables/continuedRun.ts:13-30`）＋
  `ScreenBuffer.continuedRun`（`packages/tn5250/src/screen/buffer.ts:993`）で、**既に在る**。
  **Backspace / Delete は既にチェーンを歩く**（`ScreenGrid.vue:2520` `:2552`）が、
  **打鍵（`:2745`）は歩かない**＝挿入は segment 末尾で止まる。

## 実装アンカー

- A1: 切り詰めている本体（`packages/web-ui/src/composables/fieldEdit.ts:35-36` `typeChar`）
- A2: 早期 return（同 `:31`。F2 と向きが同じ）
- A3: 空白パディングの前提（同 `:212-216` `padTo`）
- A4: `fieldEdit.paste()`（同 `:202-210`）
- A5: 貼り付けの余地判定（`packages/web-ui/src/components/ScreenGrid.vue:3090-3103` `insertInto`）
- A6: 貼り付けの拒否と通知（同 `:3231-3251` `pasteFrom`）
- A7: 符号桁への打鍵の既存ガード（`packages/web-ui/src/composables/fieldValidate.ts:334-336` `isSignPosition`）
- A8: DBCS 打鍵の余地判定（`ScreenGrid.vue:2000-2007` `absorbDbcs` / 呼び出し `:2844-2845`）
- A9: IME 確定（同 `:3419-3428`）
- A10: 既存の文言（`packages/web-ui/src/composables/opMessages.ts:58` `MSG_NO_ROOM`）
- A11: 継続欄の当 PJ 側 — `packages/web-ui/src/composables/continuedRun.ts:13-30` `continuedRunOf`
  ＋ `packages/tn5250/src/screen/buffer.ts:993` `ScreenBuffer.continuedRun`。
  打鍵が歩いていないのは `ScreenGrid.vue:2745`（Backspace/Delete の `:2520` `:2552` と対）

## 実装時の注意

- **ACS の版に依存する行番号をコードコメントに書かない**（デコンパイル結果の行番号は再現しない）。
  参照は**クラス名とメソッド名**で書く（`PS5250.reserveRoomForInsert` 等）。
  条項 `comment-provenance` の求める出所はそれで足りる。
- **逐語移植をしない**（`AGENTS.md`「ACS は IBM の独占物」）。持ち帰ってよいのは
  **規則という事実**（末尾の連続空白・符号桁を 1 つ取り置く・チェーン全体で数える）だけ。
- `EditState` は空白パディング済みなので、「末尾の空白数」は
  `chars` を後ろから走査するだけで出る。**`trimEnd().length` との差で出すと、
  中間の空白を数えてしまう形（F1 の分かれ目）とは別物なので注意**——
  実際には `chars.length - trimEnd().length` は末尾の連続空白と一致するが、
  **符号桁の取り置き（F3）を入れると一致しなくなる**ので、走査で書くほうが安全。

## design への申し送り

1. **【要判断】通知を出すか、ACS どおり音だけにするか。**
   ACS は通常の打鍵では**メッセージもエラーコードも出さず、処理されなかった音を鳴らすだけ**（F4）。
   一方**当 PJ は貼り付けで既に `MSG_NO_ROOM` を出しており**、そこは既に ACS と違う（F7）。
   - 揃える方向は 2 つ: (a) 打鍵にも `MSG_NO_ROOM` を出す（PJ 内で一貫・ACS より親切）、
     (b) ACS に合わせて両方とも音だけにする（貼り付けの既存挙動を変えることになる）。
   - `AGENTS.md` の例外条項（「ACS が情報を捨てているなら合わせない」）に当たるかは**判断が要る**。
     requirements の US3（弾かれたことが分かってほしい）は (a) を支持する。
2. **エラー 0012 は使わない**（F5）。requirements の「0012 相当」の記述は落とす。
3. **継続欄は F6 のとおりチェーン全体の予算**。FR6 はこれで確定できる。
   `AGENTS.md` 残課題の「挿入モードで 1 行が帯の幅を越えたときの ACS 挙動が未確認」は、
   **挿入に関しては閉じられる**（貼り付けの帯幅＝全角の桁ずれは別問題のまま）。
4. **取り置きは 2 条件**（F3）。符号付き数値だけでなく DBCS 専用／either-on も。
5. **残る未確認**:
   - DBCS 打鍵（A8）で ACS が音を鳴らすか（当 PJ は無言）。
   - 当 PJ の欄モデルに継続欄のチェーン相当があるか（A11）。
   - **送信値が実際に化けるか**（requirements AC2b）。web-ui 単体では確かめられないので、
     `packages/tn5250` 側か実機で出す。**この research では確かめていない。**

---

## F8: 継続欄のチェーン横断の押し出しを**実機で確認した**（2026-09-20）

`reserveRoomForContField` の読み（F6）が**実機の往復でもそのとおりに見える**ことを、
`scripts/acs-probe/cntfld-insert.txt`（ACS のコアを GUI 無しで実機に当てる）で確かめた。
条項 `measurement-sanity`——**デコンパイルの読みと実機の 2 経路**で同じ結論になった。

対象は `SNDMSG` の `MSG` パラメーターのプロンプト（CL の長い文字パラメーターは
継続入力欄 FCW 0x8601/0x8603/0x8602 で来る）。**実機にオブジェクトは作っていない。**

埋めたあと、**1 つ目の segment（5 行目）の中ほど（5,45）**へ挿入モードで `#` を 1 文字:

```
filled-to-capacity   cursor=7,31 inhibit=0
  05| … ABCDEFGH
  06|IJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOP
  07|QRSTUVWXYZ0123456789ABCDEFGHIJ

insert-in-first-segment   cursor=5,46 inhibit=0
  05| … ABCDEFG#… ← 末尾が H から G になった
  06|HIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNO
     ↑ 5 行目から押し出された H が先頭に入った
  07|PQRSTUVWXYZ0123456789ABCDEFGHIJ
     ↑ 6 行目から押し出された P が先頭に入った
```

**押し出しは segment を 2 つまたいで波及している**（H → 6 行目、P → 7 行目）。
2 文字目も同じ（`insert-again`: G が 6 行目へ、O が 7 行目へ）。

**施錠は起きない**——全 dump で `inhibit=0`（F4・decisions D2 の裏づけ）。

### この観測で**確かめられなかったこと**

**チェーン全体が満杯になった状態は作れていない。** 容量いっぱいまで入れたつもりでも
7 行目はまだ伸びており（`QRSTUVWXYZ0123456789ABCDEFGHIJ` で終わっていて末尾に余地がある）、
**「チェーン全体が満杯のときに拒否するか・落とすか」は未観測**。
F1/F6 のコードの読みでは `n8 < n2 → return false`（何も変えない）だが、
**実機では確かめていない**（原則 2 に照らして、ここは「未確認」と明記する）。

## F9: **満杯のとき ACS はメッセージを出し、キーボードを施錠する**——F4 は誤りだった（実機）

`cntfld-insert-full.txt` で欄を**容量（512 桁）超え**まで埋めて飽和させ、
1 つ目の segment の中ほど（5,45）へ挿入した結果:

```
filled-2-after-extra   cursor=5,60 inhibit=0     ← まだ入る状態
insert-when-full       cursor=5,45 inhibit=5     ← 満杯で挿入
  24| データを挿入する余地がありません。
```

- **欄の中身は 1 桁も変わらない**（`filled-2-after-extra` と `insert-when-full` の
  5〜12 行目がすべて同一）。カーソルも動かない（5,45 のまま）。
- **メッセージが出る**——`データを挿入する余地がありません。`
  これは `MSG_NO_ROOM` の doc コメントにある ACS 文言 **`"No room to insert data."`** の日本語版。
- **`inhibit=5`**＝**キーボードが施錠される**。

### F4 / F5 の訂正（原則 3。自分の読みを破棄する）

**F4「操作員エラーの表示も、メッセージも出ない。音だけ」は誤り。**
**F5「台帳の『エラー 0012 を出す』は誤り」も、実機の見え方としては誤り**
——台帳の「足りなければエラーを出し、値を変えない」は**実機の挙動と合っていた**。

読み違えた理由（推測ではなく、確かめられた範囲で書く）:
`PS5250.insertChar` → `processCharKeyStroke` → `keyDown` の経路だけを追ったが、
**プローブは `ECLPS.SendKeys` を通る**ので、追った経路と同じとは限らない。
**どの層がこのメッセージと施錠を出しているかは未特定**（`PS5250` の外の可能性が高い）。
**コードの読みで「出ない」と断定したのが誤り**で、原則 2（実機で確定できることは実機で）に
従っていれば最初から出せた。

### この work への影響

- **`MSG_NO_ROOM` を打鍵でも出すのは、ACS からの逸脱ではなく一致**（decisions D1 の前提が変わる）。
  「ACS と違える理由」を書く必要が無くなった。
- **施錠するかどうかが新しい論点**。ACS は施錠する（`inhibit=5`）。当 PJ は施錠しない。
  requirements / design の「施錠しない」は**この実測と食い違う**ので見直しが要る。
- **未確認のまま残るもの**: 単独欄（非継続欄）でも同じか。
  今回の観測は**継続欄**（SNDMSG の MSG）だけ。条項 `measurement-sanity` に従い、
  **単独欄でもう一度取る**まで「継続欄で確かめた」に留める。

## F10: **単独欄でも同じ**——値不変・メッセージ・施錠（実機。F9 の裏取り）

条項 `measurement-sanity`（1 回の観測で決めない）に従い、**継続欄ではない普通の入力欄**で取り直した。
対象は同じ SNDMSG プロンプトの **TOユーザー・プロファイル**（12,37 から 10 桁。継続欄ではない）。

```
filled              cursor=5,37  inhibit=0
  12| … TOユーザー・プロファイル . .   ABCDEFGHIJ …
insert-when-full    cursor=12,40 inhibit=5      ← 欄の中ほど(12,40)で挿入モードに X を打鍵
  12| … TOユーザー・プロファイル . .   ABCDEFGHIJ …   ← **1 桁も変わらない**
  24| データを挿入する余地がありません。
```

**継続欄（F9）と単独欄（F10）で挙動は同じ**:
値は変わらない / `データを挿入する余地がありません。` / `inhibit=5`（施錠）/ カーソルも動かない。

### 途中で踏んだ誤り（記録として残す）

1 回目は満杯にしたあと `[left]` で戻そうとしたが、**10 桁を埋めると自動送りで次の欄へ飛ぶ**ため
左へ動くと**保護域**に入り、`画面の保護域にカーソルがある。`（これも `inhibit=5`）が出た。
**別の理由の施錠を「満杯の施錠」と読み違えるところだった**——
`setcursor` で欄の桁を直に指す形に直した（`single-field-insert-full.txt` に注記済み）。
**`inhibit` が立ったことだけを見て結論を出してはいけない**（24 行目の文面まで見る）。

## F11: **カーソルが最終桁の上にあると、空きが残っていても拒否する**（実機。F2 の裏取り）

design の「未確定事項 3」——`cursorSBA == getEndPos()` の即時拒否（F2。デコンパイルの読み）が
実機でも見えるか。**当 PJ は `cursor === len-1`（最終桁の上）を通す**ので、差が出るかどうかの分かれ目。
手順: `scripts/acs-probe/single-field-insert-endpos.txt`（TOUSR＝12,37 から 10 桁）。

**満杯にしない**のが要点。F9/F10 は「空きが無いから拒否」だったが、ここで見たいのは
**空きが残っていても最終桁なら拒否するか**という**別の条件**なので、3 桁だけ入れて空きを残した。

```
filled-3                 cursor=12,40  inhibit=0   ← ABC だけ。46 桁目まで空き
control-insert-not-last  cursor=12,46  inhibit=0   ← 12,45（最終桁の 1 つ手前）へ Y を挿入
  12| … TOユーザー・プロファイル . .   ABC     Y        ← **通る**
insert-at-endpos         cursor=12,46  inhibit=5   ← 12,46（最終桁）へ Z を挿入
  12| … TOユーザー・プロファイル . .   ABC     Y        ← **1 桁も変わらない**
  24| データを挿入する余地がありません。
```

**46 桁目は空白だった**（＝空きはある）のに拒否された。**空きの数え方では説明できない**——
末尾の連続空白をカーソルまで数える規則（F1）では、どちらの位置でも空きは 1 で、
対照（12,45）は実際に通っている。**最終桁という位置そのものが独立した拒否条件**。

**対照を同じ run に置いたことが効いた**。拒否だけを見ると「その前から止まっていた」可能性を
排除できない。直前に同じ欄・同じ挿入モードで 1 文字通していることが、それを潰している。

**F2（デコンパイルの読み）と実機が一致**——条項 `measurement-sanity` の「別の経路でもう一度」を
満たす。F4/F5 では読みが実機と食い違ったので、一致したことにも意味がある。

### この work への影響（design の未確定 3 が決着）

- **当 PJ は差がある**。`typeChar` は `cursor >= len` でしか弾かない（`fieldEdit.ts:31`）ため、
  `cursor === len-1` は通って**最終桁に書き込んでしまう**。ACS は拒否する。
- AGENTS.md 判断の原則 1（ACS が正典）に従い、**挿入モードでは `cursor === len-1` を拒否する**。
  上書きモードは対象外（ACS も `insertChar` の話）。
- **副作用として「挿入モードでは最終桁に直接打てない」**という規則になる。
  最終桁を埋めるには手前の桁から押し出す。奇異に見えるが**実測どおり**であり、
  原則 3（実測が過去の決定に優先する）に従う。
- 拒否の見え方は F9/F10 と同じ（値不変・同じ文言・`inhibit=5`）なので、
  **通知は `MSG_NO_ROOM` を共用できる**。新しい文言は要らない。
