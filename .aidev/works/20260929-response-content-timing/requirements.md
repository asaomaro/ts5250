# 要件: READ SCREEN の応答の中身を命令の時点の画面にする

## 背景 / 課題
台帳「節目の懸念の残り」の「応答の中身を命令の時点の画面で組まない」。当 PJ は応答をレコードを適用し終えた後の画面で組んでおり、同じレコードで READ SCREEN の後ろに画面を書き換える WTD が続くと、応答に書き換え後の内容が入っていた。

## 目的 / ゴール
1 本のレコードに `[READ SCREEN][画面を書き換える WTD]` が載ったとき、ホストへ返す READ SCREEN の応答が、ACS と同じく命令の時点の画面（書き換え前）になっている状態。

## ユーザーストーリー
- US1: 画面を読み取るホストのプログラム（ASSUME 付きの窓・画面取り込み）の作者として、READ SCREEN で受け取る画面が、命令を出した時点のものであってほしい。なぜなら、同じレコードの後ろの書き込みが混ざると、ホストが「今見えている画面」を取り違えるから。（受け入れ: AC1, AC2）

## スコープ
### 対象
- READ SCREEN（0x62）と READ SCREEN TO PRINT（0x66・0x6a）の応答（`read-screen` の応答枠）

### 対象外（台帳に残す）
- SAVE SCREEN の退避の本体: ACS のものは Java の直列化で当 PJ とは別の形。ホストには不透明な保管物で、当 PJ の RESTORE はローカルの退避スタック（SAVE の命令の時点で取る）から復元するので、中身の差は画面に出ない
- READ SCREEN EXTENDED（0x64・0x68）・READ IMMEDIATE（0x72）・READ MDT IMMEDIATE ALT（0x83）: 未測定

## 完了条件 (受け入れ基準)
- [ ] AC1: `[READ SCREEN][WTD で OLD→NEW]` の応答が OLD、対照の `[WTD][READ SCREEN]` の応答が NEW になる（単体）
- [ ] AC2: 実機（DSM の READSCRTIMING）で、当 PJ のコアの応答が ACS のワイヤと同じ（READSCRTIMING は OLD・READSCRTIMING2 は NEW）
