# 要件: O 欄の編集を ACS と同じセルの並びで行う

## 背景 / 課題
`.aidev/backlog/acs-parity.md` の「O 欄の挿入のあとのバイト列が ACS と違う（並びの境目の SO/SI）」と、「O 欄が全角で始まるときの先頭の桁の選択」（節目の懸念の残り）。
ACS の O 欄（DBCS open。FCW 0x8280）は SO・SI・全角・半角をセルとして直接書き換え（`PS5250.inputChar` / `insertChar` / `processDeleteChar` / `processBackspace` / `eraseToEOF`）、
挿入で並びを分け、全角を消しても空の SO/SI を残し、カーソルを SO・SI の桁にも置く。当 PJ は論理値（SO/SI 無し）を編集して送るときに SO/SI を付け直すので、
これらの状態を表せず、送るバイト列・空きの数え方・カーソルの位置が ACS と違う。

## 目的 / ゴール
O 欄（継続欄を除く）で、打鍵（上書き・挿入）・Delete・Backspace・Erase EOF・Field Exit の結果のセルの並びとカーソルが ACS と同じになり、ホストへ届くバイト列も同じになる状態。

## ユーザーストーリー
- US1: 日本語の O 欄を編集する利用者として、ACS と同じ結果になってほしい。なぜならホストに届くバイト列（SO/SI の位置）が違うと、アプリの受け取る値の長さと中身が ACS と変わるから。（受け入れ: AC1, AC2, AC3, AC4）

## スコープ
### 対象
- 継続していない O 欄の上書き・挿入・Delete・Backspace・Erase EOF・Field Exit・Field±、カーソルの SO/SI の桁への移動、Tab・Backtab の着地
- 当 PJ 独自の操作（選択の削除・語の削除・複数行の貼り付け）は、ACS に無いので並びを正規化するだけ
### 対象外
- 継続した O 欄（ACS `processCharWithDBCSOpenContField`。台帳の別項目のまま）
- E・J・G 欄（今回の作りに乗せない）

## 完了条件 (受け入れ基準)
- [ ] AC1: 上書き・挿入の結果のセルの並び・カーソルの進み・エラー（0005・0012・0065・黙って何もしない）が ACS の表と同じ（単体。ACS のコアで打鍵したバイト列と突き合わせる）
- [ ] AC2: Delete・Backspace・Erase EOF・Field Exit が ACS と同じ（空の SO/SI を残す・組を 2 桁で消す・並びの途中の消去で SI を置く）（単体・ACS のコア）
- [ ] AC3: ホストへ届くバイト列が ACS と同じ（O 欄の値は SO/SI の印を持ち、コアはセルを構造どおりに置いて付け直さずに送る）（単体・実機）
- [ ] AC4: カーソルは O 欄の SO・SI の桁に止まり、Tab・Backtab は SO に着く（単体）
