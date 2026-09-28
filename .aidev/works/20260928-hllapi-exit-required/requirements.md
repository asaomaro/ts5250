# 要件: HLLAPI でも、打ったまま欄を出ていない右寄せ・符号付き数値の欄から AID を送らない（ACS のエラー 0x20）

## 背景 / 課題
台帳「AID の前の検査の残り」。ACS `PS5250.processAIDCode` は、カーソル下の欄が符号付き数値・右寄せ（RZ・RB）で MDT があり、欄の `fieldExitReqFlag` が下り、
`fieldExited` でなく、自動 Enter でもなければエラー 0x20 で送らない。ペインは対応済み（`awaitingFieldExit`）。当 PJ の HLLAPI は「欄を出た」を追っておらず、送っていた。

## 目的 / ゴール
HLLAPI（ECL の `SendKeys` と同じ経路）で ACS と同じ所で止まり・送れる状態。

## ユーザーストーリー
- US1: HLLAPI で画面を操作する自動化の作者として、ACS と同じく右寄せの欄を出ずに Enter を送れば止まってほしい。なぜなら、ACS で動くマクロが当 PJ では左寄せのままの値をホストへ送ってしまうから。（受け入れ: AC1〜AC3）

## スコープ
### 対象
- HLLAPI の `SendKey`（3）の AID の前の検査
### 対象外
- Field Exit・Field± のニーモニック（HLLAPI の表に無い——既知の差）
- MCP の `send_key`（ACS に無い入口。合わせるかは要判断——台帳に残す）

## 完了条件 (受け入れ基準)
- [ ] AC1: RZ・RB・符号付き数値の欄に打って、欄を出ずにその欄から AID → `rc=5` で送らない（同じ欄の中への Set Cursor・別の欄を経た Set Cursor・左右の矢印でも）
- [ ] AC2: Tab・Backtab・Home・上下の矢印でその欄に着き直すか、欄の終わりまで打てば送れる。自動 Enter の欄・打っていない欄は見ない
- [ ] AC3: 実機（当 PJ の HLLAPI）で ACS と同じ 6 場合の結果
