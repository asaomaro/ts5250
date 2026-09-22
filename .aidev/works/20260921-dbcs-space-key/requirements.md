# 要件: J・G・E（DBCS 中）の欄の Space を全角空白にする（ACS と同じ）

## 背景 / 課題
- 台帳「キー編集の細部」の調査（R11・`key-edit-rest` (r)）で見つかった、台帳に無かった差。ACS `PS5250.processCharKeyStroke` は、DBCS のセッションで打った字が空白のとき
  `convertSBCSCharToDBCS` で全角空白（U+3000）に置き換える（対象は J・G・E の DBCS オン。O は対象外）。
- 当 PJ は J・G の半角 Space を `dbcs-required`（「この項目には全角文字しか入力できません」）で弾く。IME を切って（直接入力）Space で桁を空ける・欄を埋める操作は日常的。
- 実機の ACS のコアで測った（`scripts/acs-probe/dbcs-space-key.txt`。DBCSFE の画面・930）: G・J は `あ`＋Space＋`い` が `あ　い`、先頭の Space も全角空白。O は SBCS の空白のまま。
  E は空の欄・SBCS の字の後の Space が SBCS の空白で、`あ` の後は全角空白（E は最初の字で状態が決まる）。

## 目的 / ゴール
- DBCS の欄で打った Space が、ACS と同じ規則で全角空白になる（J・G は常に、E は DBCS の状態のときだけ、O は変えない）状態。

## ユーザーストーリー
- US1: ACS から移る利用者として、日本語の入力欄で Space を押したら、ACS と同じく全角の空白が入ってほしい。なぜなら、エラーで止まると入力の流れが途切れるから。（受け入れ: AC1〜AC4）

## スコープ
### 対象
- 打鍵の経路（`ScreenGrid.vue` の DBCS 欄の keydown）。
### 対象外
- 貼り付け・IME の確定（ACS の `processCharKeyStroke` は打鍵だけ）。E 欄で SBCS と DBCS を混ぜる規則（ACS は拒否する。別の差）。

## 完了条件 (受け入れ基準)
- [ ] AC1: J・G の欄で Space を打つと全角空白が入り、エラーにならない（先頭でも途中でも）。
- [ ] AC2: E の欄は、全角の字が入っているときだけ全角空白。空の欄・SBCS の字の後は SBCS の空白のまま。
- [ ] AC3: O の欄・SBCS の欄は SBCS の空白のまま。
- [ ] AC4: 各分岐を外すとテストが落ちる（`verify-by-mutation`）。
