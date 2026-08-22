# 仕様

## D1. 発行の手立て

| 出したいもの | API |
|---|---|
| `ROLL`(0x23) | `QsnRollUp` / `QsnRollDown` |
| `READ IMMEDIATE`(0x72) | `QsnReadImm` |
| `READ MDT IMMEDIATE ALT`(0x83) | `QsnReadMDTImmAlt` |
| 任意の入力コマンド | `QsnPutInpCmd(cmd, …)` |
| 任意の出力コマンド | `QsnPutOutCmd(cmd, …)` |

C プログラム 1 本（`scripts/host-src/dscmd.c`）に引数で切り替える形で入れ、
5250 セッションから `CALL` して**送受信の生バイト**とホスト側のログを突き合わせる。

## D2. 実装するかどうかは**待つかどうか**で決める

backlog が存在する理由は「**捨てた後ろに READ があると入力待ちに入り、利用者には
『待機中』としか見えない**」。だから判断基準は**ホストが待つか**。

- 待つ → **実装する**（`0x83` / `0x66` 系がこれだった）
- 待たない → 従来どおり警告して捨てる（未知の出力コマンドがこれだった）

## D3. `0x83` の中身

**MDT の立った欄だけ・AID 0**（名前 READ **MDT** IMMEDIATE ALT どおり）。
tn5250j `ScreenFields.readFormatTable` の `CMD_READ_MDT_IMMEDIATE_ALT` に従う。
`buildReadMdtResponse` に AID 0 を渡したものと同値。

## D4. `READ SCREEN TO PRINT` の中身

**画面イメージ**（`READ SCREEN`(0x62) と同じ形）。拡張版（0x68 / 0x6C）は
`READ SCREEN EXTENDED`(0x64) と同じ行区切り形式。

## D5. 負応答は入れない

未知の**出力**コマンドではホストが待たないことを実測した。原典 2 つは返すが、
**返さなくても止まらない**。形式を確かめられないものを推測で送るより、黙って捨てて
警告で気づけるようにする方を採る。
