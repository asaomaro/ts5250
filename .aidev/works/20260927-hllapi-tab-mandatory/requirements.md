# 要件: HLLAPI の Tab・Backtab・Home で欄を出るときの MF・自己点検

## 背景 / 課題
`.aidev/backlog/acs-parity.md`「節目の懸念の残り」: ACS の `processTab` / `processBacktab` / `processHome` は移動の後に `moveCursorWithMandFillCheck` を通し、
MF（必須埋め）の欄を部分入力のまま出ようとするとエラー 20、自己点検の合わない欄ならエラー 21 で止め、カーソルを欄の先頭へ戻す。
当 PJ の HLLAPI の `@T` / `@B` / `@0` は行き先へ動かすだけで検査しない（ペインは検査する）。

## 目的 / ゴール
HLLAPI で欄を出るキーを送ったとき、ACS と同じく MF・自己点検の違反で止まり、後ろに続くキーが入らない状態。

## ユーザーストーリー
- US1: HLLAPI で画面を操作する自動化の作者として、MF 欄を埋めずに Tab で出ようとしたら ACS と同じく止まってほしい。なぜなら止まらないと、ACS では弾かれる不完全な値がそのままホストへ届くから。（受け入れ: AC1, AC2, AC3）

## スコープ
### 対象
- HLLAPI SendKey の `@T`（Tab）・`@B`（Backtab）・`@0`（Home。ホーム位置へ動くとき）
### 対象外
- HLLAPI・MCP の AID の前の検査（ACS `processAIDCode` の ME・MF・Field Exit 必須・自己点検）——当 PJ は core にもサーバーにも無い。別の項目として台帳に積む
- 3270 のセッションの Tab の規則（ACS `PS3270`）——同じ台帳項目の別の小項目

## 機能要件
- 欄の外へ出る Tab・Backtab・Home で、出る欄が MF（MDT あり・空でも満杯でもない）か自己点検の違反なら、カーソルを出る欄の先頭に置き `rc=5` を返し、以降のキーを処理しない
- 同じ欄の中の移動（欄の途中からの Backtab で欄頭へ戻る等）は検査しない

## 完了条件 (受け入れ基準)
- [ ] AC1: MF の欄を部分入力のまま Tab・Backtab・Home で出ると、カーソルは欄頭・`rc=5`・後ろのキー（文字・AID）は処理しない（単体・実機）
- [ ] AC2: 自己点検の合わない欄を Tab で出ると同じく止まる。合う値・空の欄・満杯の MF・MDT の無い MF は止まらない（単体）
- [ ] AC3: 同じ欄の中の移動では止まらない（欄の途中からの Backtab）（単体・実機）

## 未確定事項 / 確認したいこと
- なし（ACS の挙動は `scripts/acs-probe/hllapi-tab-mandatory.txt` で実測済み）
