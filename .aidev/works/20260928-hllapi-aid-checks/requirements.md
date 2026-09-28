# 要件: HLLAPI の AID の前に ACS と同じ MF・自己点検・ME の検査をする

## 背景 / 課題
`.aidev/backlog/acs-parity.md`「HLLAPI・MCP の AID の前の検査が無い」（`20260927-hllapi-tab-mandatory` で割った項目）: ACS `PS5250.processAIDCode` は AID の前に、カーソル下の欄の MF（エラー 20）・
欄を出ずに送る右寄せ・符号付き数値（32）・自己点検（21）、画面が変更済みなら ME（7。CA キーは除く）を見て止まる。ペインは同じ検査をするが、HLLAPI の `@E`・F キー等は core の `sendAid` へそのまま渡す。

## 目的 / ゴール
HLLAPI で AID キーを送ったとき、ACS と同じく MF・自己点検・ME の違反で止まり、ホストへ送らない状態。

## ユーザーストーリー
- US1: HLLAPI で画面を操作する自動化の作者として、必須の欄を満たさずに Enter を送ったら ACS と同じく止まってほしい。なぜなら止まらないと、ACS では弾かれる値がホストへ届き、ACS と違う結果になるから。（受け入れ: AC1, AC2, AC3）

## スコープ
### 対象
- HLLAPI SendKey の AID キー（Help・Clear・Record Backspace・Test Request・Attn・SysReq を除く）
### 対象外
- エラー 32（欄を出ずに AID）: HLLAPI は「欄を出た」を追跡していない（Field Exit のニーモニックも無い）。台帳に残す
- MCP の `send_key`: ACS の機能ではない（MCP は ACS に無い入口）。台帳に残す

## 完了条件 (受け入れ基準)
- [ ] AC1: カーソル下の欄が MF の違反（途中まで）なら、欄頭へ戻して `rc=5`、送らない。CA キーでも止まる（単体・実機）
- [ ] AC2: カーソル下の欄が自己点検の違反なら同じく止まる（単体）
- [ ] AC3: 画面が変更済みで、MDT の無い ME の欄があれば、その欄の先頭へ動かして `rc=5`、送らない。CA キー・未変更の画面では見ない。Help・Clear・Record Backspace・Test Request・Attn・SysReq は検査しない（単体・実機）
