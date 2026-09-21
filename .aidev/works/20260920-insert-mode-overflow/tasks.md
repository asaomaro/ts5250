# タスク: 挿入モードで欄が満杯のとき、黙って文字を捨てない

> **改訂 3（doccheck ラウンド 2・指摘 11 件／うち must 1 件を反映）。**
> ラウンド 1 は「T1 が最初」という制約が散文だけだった点を突き、T4 に `依存: T1` を足して閉じた。
> **ラウンド 2 は、その当て漏れが T11（T4 の下流でない唯一の修正タスク）に残っていた**ことを突いた
> ——**同じ欠陥が 2 ラウンド続けて別の場所に出た**ので、
> 「**利用者から見える挙動を変えるタスクはすべて T1 の下流**」を不変条件として書き下す。
> あわせて孤立していた T6 を回収し、AC6 と `either` の判断に回帰資産を付けた。

## 実装方針

design 改訂 3 の順に、**下から積む**——純関数（`reservedTail` / `trailingRoom`）→ `typeChar` →
呼び出し側（4 経路）→ テスト。純関数が先なのは、**この work の誤りが 2 回ともここで起きた**ため
（取り置きを引き算にした／要る桁数の引数が無かった）。

**subtask 分割はしない。** 実装の変更は 2 ファイル（`fieldEdit.ts` / `ScreenGrid.vue`）＋テストに
閉じており、単独で検証・デリバリ可能な seam が無い（`aidev-docs/DESIGN.md`「5.」の 3 層決定木で
「不可分」）。※ これに加えて記録の更新（`test-result.md` / `AGENTS.md` の残課題 / 台帳）が
付くが、**これらは実装の seam ではない**ので分割の判断には効かない。

## 作業順序と依存関係

**散文だけの順序制約を残さない**（doccheck ラウンド 1 の must）。順序はすべて `依存:` で強制する。
機械的な依存で表せない「理由」だけをここに書く。

- **不変条件: 利用者から見える挙動を変えるタスク（T4 / T5 / T8〜T11）は、すべて T1 の下流に置く。**
  修正を当てると症状が再現せず、**観測機会は一回きり**だから。
  ファイルの依存ではなく**一回性**による順序なので、`依存:` を読むだけでは理由が分からない
  ——だからここに書く。**新しく挙動を変えるタスクを足すときは、この不変条件を確かめること**
  （ラウンド 1 で T4、ラウンド 2 で T11 に当て漏れた。**2 回とも同じ欠陥**）。
- **T20（mutation 検証）が全テストタスクの依存を持つのは、戻して落ちる対象が
  そろっていないと検証にならないため。**

## リスク / 留意点

- **`typeChar` のシグネチャを変える**（`opts` を足す）。既定値（`need=1` / `reserved=0`）で
  従来の呼び出しはそのまま通るが、**既定のまま通る呼び出し元が残ると「取り置きが効かない経路」が
  静かに残る**（この work の主題そのもの）。**T6 で数える。**
- **DBCS 欄では配列長が変わる**（`need=2` で 1 減る）。`chars.length` を欄長だと思っている
  コードが他にあれば壊れる。**T6 で洗う。**
- **AC12 は利用者から見える挙動変更**（挿入モードで最終桁に直接打てなくなる）。
  実測どおりだが驚かれうるので、**T5 で `decisions.md` D4 への参照をコードに残す**。

### 条項 `test-input-shape`: 振る「形」と担当タスク

**10 の形を宣言し、どのタスクが振るかをここで割り当てる**（宣言だけして振り漏らさないため）。
下 2 行は**欄の中身ではなく取り置きの入力を振る形**で、ラウンド 2 の指摘で足した
——`reservedTail` と `roomOptsOf` にだけ回帰資産が無かった。

| 形 | 担当 |
|---|---|
| 満杯（`cursor < len-1`。最終桁の上は別行） | T13 |
| 中間に空白があるが末尾は詰まっている | T12（AC11） |
| **符号桁が空白**（取り置きの有無で割れる） | T12（AC11b） |
| **符号桁が最終桁**（取り置きの効かせ方で割れる） | T12（AC11c） |
| 最終桁の上にカーソル（挿入は弾く／上書きは通る） | T13（AC12） |
| 全角（`need=2`。バイト数保持・配列長 −1） | T13 |
| 選択範囲あり（弾かれない） | T17 |
| **空欄（全桁が空白）** | T13 |
| **`reservedTail` の入力**（符号付き / DBCS 取り置き / どちらでもない） | T12 |
| **`dbcsType` の切り分け**（`only` / `pure` / **`either` は取り置かない**。decisions D5） | T14 |

## テスト方針

- **純関数は表駆動。ただし 2 つの関数で軸が違う**（ラウンド 2 の指摘）:
  - `trailingRoom` は **`cursor` × `reserved` の 2 軸**。`need` は引数ではなく `typeChar` の
    `opts` なので、**3 軸目は T13（`typeChar` の層）で振る**
    （ラウンド 1 の must: 方針が 3 軸と書いて関数側に無かった）。
  - `reservedTail` は `reserved` を**返す**側なので上の 2 軸に乗らない。
    振るのは**入力の組**（符号付き / DBCS 取り置き / 両方 / どちらでもない）。
- **経路横断は「同じ入力を 4 経路に通して同じ結果」**（AC4）。前 work の実測で、
  関数を共有しているだけでは**呼ぶ位置がずれていても緑になる**と分かっているため
  （条項 `paired-artifact-sync`）。
- **mutation 検証**（AC9・条項 `verify-by-mutation`）は **5 か所**を戻して**落ちることまで確かめる**。
  とくに **AC11c は「引き算に戻すと落ちる」**ことが要——ここが design の must 指摘だった。
  5 つ目（`either` を取り置く側へ倒す）はラウンド 2 の指摘で足した
  ——decisions D5 の判断だけ回帰資産が無かった。
- **web-ui のテストは必ず `cd packages/web-ui && npx vitest run`**（`AGENTS.md`。
  ルートから回すと vue plugin とフィクスチャの相対パスが解決されず**偽陽性が出る**）。
  **T21 のコマンド列にもこの形で書く。**

## タスク

- [x] T1: **修正を当てる前に**、符号付き数値欄で符号が落ちる様子を実機で観測し、
      生出力を `test-result.md` に残す。条項 `measurement-sanity` に従い**別経路でもう一度**取る。
      観測できなければ「何を試して何が起きたか」を書く（「未検証」の一語では満たさない）。
      対象: `scripts/verify-browser-sign.mjs`（実機へ web-ui を当てる既存ハーネス。**挿入モードは未カバー**
      なので打鍵を足す）/ 画面は `scripts/build-sgntest.mjs` の `SGNDSPF/SGNPGM`（`6S 0` ＝ 6 桁符号付き。
      同 `:9` が「原典どおりの `    12-`（最終桁が符号桁）」と記す）。**実機に作ったものは片付ける**
      （既存スクリプトが `DLTF` / `DLTPGM` を持つ。`AGENTS.md`）
      依存: なし
      AC: AC8
- [x] T2: `reservedTail(opts: { signedNumeric?, dbcsReserved? })` を新設する（**引数を取る**
      ——T7 の `roomOptsOf(f)` が作った opts を渡す。T11 も同じ形で呼ぶ）。返すのは**取り置く末尾の空白スロット数**
      （符号付き数値欄で 1・DBCS 取り置きで 2）。JSDoc に ACS の**クラス／メソッド名**を書く
      （行番号は書かない。版で動くため）。
      対象: `packages/web-ui/src/composables/fieldEdit.ts` （新規関数）/ 根拠: design §1
      依存: なし
      AC: AC6
- [x] T3: `trailingRoom(chars, { cursor, reserved })` を新設する。
      **`reserved` は走査の開始位置をずらす量**。**結果から引かない**——
      なぜ引いてはいけないか（符号は最終桁なので末尾から数えると常に 0）をコメントに残す。
      対象: `packages/web-ui/src/composables/fieldEdit.ts` （新規関数）/ 根拠: design §2
      依存: なし
      AC: AC6, AC11, AC11b, AC11c
- [x] T4: `typeChar` に `opts { need, reserved }` を足す。空きが `need` 未満なら `state` を
      そのまま返し、足りるなら `splice` して**末尾の空白を `need` 個捨てる**
      （捨てる前に空白か検査する）。**上書きモードは変えない**。
      対象: `packages/web-ui/src/composables/fieldEdit.ts:29-42` `typeChar` / 根拠: design §3 手順 2,3
      依存: T1, T2, T3
      AC: AC1, AC2a, AC5
- [x] T5: `typeChar` に**最終桁の上（`cursor === len-1`）の拒否**を足す（挿入モードのみ）。
      **`decisions.md` D4 への参照**と、根拠が実機観測（research F11）であることをコメントに残す
      ——利用者から見える挙動変更なので、後から「なぜ弾くのか」が読めるように。
      対象: `packages/web-ui/src/composables/fieldEdit.ts` `typeChar` / 根拠: design §3 手順 1, decisions D4
      依存: T4
      AC: AC12
- [x] T6: **既定値に頼る呼び出し元**（`need`/`reserved` を渡さない `typeChar` の呼び出し）と、
      **`chars.length` を欄長と見なしている箇所**を洗い出し、**壊れているものはこのタスクで直す**
      （洗い出しだけで終わらせない——直す担当が他に無い）。見つかった箇所と判断を `decisions.md` に残す。
      対象: 未特定（`packages/web-ui/src/` を `typeChar` / `chars.length` で走査する。起点は調査で決まる）
      依存: T4
      AC: なし
- [x] T7: `roomOptsOf(f)` を新設する。`dbcsReserved` は `dbcsType` が `"only"` / `"pure"` の
      ときだけ true（`either` は false）。**なぜ `either` を外すか**を decisions D5 を参照する形で
      コメントに残す。
      対象: `packages/web-ui/src/components/ScreenGrid.vue` （新規関数）/ 根拠: design §0, decisions D5
      依存: なし
      AC: なし
- [x] T8: 打鍵経路に検査を置く。**`deleteSelection` が false の側（`else`）**に置き、
      弾いたら `emit("notice", MSG_NO_ROOM)` して return（カーソルを動かさず `advanceIfFull` も通らない）。
      コメントには「**ACS も同じ趣旨のメッセージを出す**（実機で確認）」という出所を書く
      （**「ACS と違える理由」は書かない**——違えていないため。decisions D1）。
      対象: `packages/web-ui/src/components/ScreenGrid.vue:2726-2745` / 根拠: design §4
      依存: T4, T5, T7
      AC: AC3, AC-I2, AC-I3
- [x] T9: `fitsBytes` 失敗時の**無言 `return` に通知を足す**（従来は黙って捨てていた）。
      対象: `packages/web-ui/src/components/ScreenGrid.vue:2747` `fitsBytes` の呼び出し側（**T8 が同ファイルに挿入するので行はずれる。シンボルで探す**）/ 根拠: design §4 の最終行
      依存: T8
      AC: AC3
- [x] T10: **DBCS 打鍵**（`absorbDbcs` が `undefined` を返す経路）と **IME 確定**に同じ検査を置く。
      全角は `need=2`。
      対象: `packages/web-ui/src/components/ScreenGrid.vue` の `absorbDbcs` の呼び出し側（`:2844-2845`）と IME 確定ハンドラ（`:3419-3428`）（**T8/T9 の挿入で行はずれる。シンボルで探す**）/ 根拠: design §4
      依存: T8
      AC: AC3, AC4
- [x] T11: `insertInto` の予算から取り置きを引く（`visLen(f) - reservedTail(roomOptsOf(f))`）。
      **両辺ともバイト**。**最終桁の拒否は掛けない**（design「扱わない」・decisions D4）。
      既存の `MSG_NO_ROOM` 通知（`:3231-3251`）はそのまま活きる。
      対象: `packages/web-ui/src/components/ScreenGrid.vue:3090-3103` `insertInto` / 根拠: design §5
      依存: T1, T2, T7
      AC: AC4
- [x] T12: 純関数のテストを書く（表駆動・`cursor` × `reserved`）。**採否が割れる形**を必ず含める——
      AC11（`"AB  C "` → 1）/ AC11b（`"  123 "` cursor=2 で取り置きの有無）/
      **AC11c（`["1"," "," "," "," ","-"]` cursor=1 で開始位置ずらし 4 対 引き算 0）**。
      あわせて **`reservedTail` の入力の組**（符号付き / DBCS 取り置き / 両方 / どちらでもない）を振り、
      **AC6 の参照コメントが実在することを走査で固定する**——`fieldEdit.ts` の原文（コメントを
      落とさない生テキスト）に ACS のクラス／メソッド名が現れること。
      ※ `test/source-scan.ts` の `code()` は**コメントを落とす**ヘルパなので**ここでは使わない**
      （用途が逆。あれは「コメントで誤って緑になる」のを防ぐためのもの）。
      対象: `packages/web-ui/test/field-edit.test.ts` （追記）/ 根拠: design §1 §2
      依存: T2, T3
      AC: AC6, AC11, AC11b, AC11c
- [x] T13: `typeChar` のテストを書く。**上の `test-input-shape` の表で T13 に割り当てた 4 形**
      （満杯 / 最終桁の上〔挿入は弾く・**上書きは通る**〕/ 全角〔バイト数保持・配列長 −1〕/ **空欄**）
      に加え、既存の `"AXB  "` が緑のままも確かめる。**弾いたとき欄に何も残らない**ことも見る（AC-I2）。
      対象: `packages/web-ui/test/field-edit.test.ts` （追記）/ 根拠: design §3
      依存: T4, T5
      AC: AC1, AC2a, AC5, AC12, AC-I2
- [x] T14: **経路横断のテスト**を書く——打鍵 / 貼り付け（`insertInto`）/ DBCS 打鍵 / IME に
      **同じ入力を通して同じ結果**になること。関数の共有だけでは呼ぶ位置のずれを拾えないため、
      **経路ごとに実際に発火させる**形で書く。
      あわせて **`roomOptsOf` の `dbcsType` の切り分け**（`only` / `pure` は取り置き、
      **`either` は取り置かない**）を固定する——decisions D5 の判断に回帰資産が無かったため。
      対象: `packages/web-ui/test/screen-grid.test.ts` （追記）/ 根拠: design AC4, decisions D3, D5
      依存: T8, T9, T10, T11
      AC: AC4
- [x] T15: 通知のテストを書く。**打鍵・DBCS・IME の 3 経路で新たに `MSG_NO_ROOM` が出ること**と、
      **貼り付けでは取り置きを足した後も既存の通知が出ること**（計 4 経路）。
      **定数で照合する**（ACS の文言と同一ではないので文字列リテラルを書かない）。
      あわせて通知が `EmulatorPane` の capture で次のキー操作のときに消えることを見る（AC-I1）。
      対象: `packages/web-ui/test/field-keystroke-rules.test.ts` / `packages/web-ui/test/op-message-line.test.ts` / 根拠: design §4, AC-I1
      依存: T8, T9, T10, T11
      AC: AC3, AC-I1
- [x] T16: **ホストへ送られる値が変わらない**ことを確かめる（符号が落ちない）。
      **手段は実機に決める**（二択で残さない）——`verify-browser-sign.mjs` 自身が
      「負値が本当に届くかはここでしか分からない。単体テストは送信バイトまでしか見ておらず、
      ホストがそれを −12 と解釈するかは実機に聞くほかない」と書いており、AC2b は
      **ホストの解釈**を問うているため。T1 と同じ実行で取る（修正の前後で 1 回ずつ）。
      対象: `scripts/verify-browser-sign.mjs`（T1 で足した挿入モードの打鍵に、送信後の
      ホスト側の値の確認を足す）/ 根拠: design AC2b
      依存: T1, T4, T5
      AC: AC2b
- [x] T17: **既存の操作を妨げないこと**の回帰——上書きモード / 貼り付け / Dup / field-exit /
      日付・時刻ピッカーの `forceOverwrite` / **選択置換**（`else` に置いたので弾かれない）。
      **弾いたときカーソルが進まない**ことも見る（AC-I3）。
      対象: `packages/web-ui/test/screen-grid.test.ts` `…/field-sign-dup.test.ts` `…/datetime-picker-ui.test.ts` / 根拠: design AC-I4
      依存: T8, T11
      AC: AC-I3, AC-I4
- [x] T18: 継続欄が **segment 末尾で黙って切り詰めず弾く**ことをテストで固定する。
      対象: `packages/web-ui/test/continued-field-edit.test.ts` （追記）/ 根拠: design「扱わない」
      依存: T8
      AC: AC7
- [x] T19: 記録の同期——`AGENTS.md` 残課題「挿入モードで 1 行が帯の幅を越えたときの ACS 挙動が未確認」は
      **実測で埋まった**ので更新し、**チェーン横断の押し出しは台帳へ**（1 経路の観測である旨を併記）。
      対象: `AGENTS.md`「残課題」/ `.aidev/backlog/acs-parity.md` / 根拠: research F8, design「扱わない」
      依存: T18
      AC: AC7
- [x] T20: **mutation 検証**（条項 `verify-by-mutation`）。**5 か所**を戻して**落ちることを確かめ**、
      落ちたテスト名を `test-result.md` に残す——(1) T4 の「足りなければ返す」を消す、
      (2) T3 の `reserved` を**引き算に戻す**、(3) T8 の通知を消す、(4) T5 の最終桁の拒否を消す、
      (5) T7 の `either` を**取り置く側へ倒す**。
      **1 つでも落ちなければ、そのテストは固定できていない。**
      対象: `packages/web-ui/src/composables/fieldEdit.ts` `…/ScreenGrid.vue`（一時的に戻す）/ 根拠: design AC9
      依存: T6, T12, T13, T14, T15, T16, T17, T18
      AC: AC9
- [x] T21: **test 工程で消化する**——`npm test` / `npm run build` /
      `npm run build -w @ts5250/web-ui` / `npm run lint` / `aidev smoke`、および
      **`cd packages/web-ui && npx vitest run`**（ルートからでは偽陽性が出るため必須）。
      coding では未チェックのまま承認してよい（`decisions.md` D6 に記録）。
      対象: 未特定（リポジトリ全体。個別の変更起点を持たない）/ 根拠: design AC10
      依存: T19, T20
      AC: AC10
