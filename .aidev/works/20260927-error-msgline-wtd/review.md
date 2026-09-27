# レビュー記録: エラー状態のままメッセージ行へ WTD・RESTORE が来たとき

## タスク点検ログ（T1 と review を兼ねた点検）
- [must][conv:-] research F2 の「ホストの出力は保留」は言いすぎ（保留は WTD だけ）/ 対応: 原典どおりに書き直した
- [must][conv:measurement-sanity!] research F1 の RESTORE は 1 回の観測で、保留と上書きを区別できない形 / 対応: 24 行を替える形で測り直し、即時に処理され Reset の戻しで上書きされると確かめた
- [should][conv:-] 保留の条件は MsgLinePos（SysReq も）/ 対応: 書いた
- [should][conv:-] clearErrorMode の契機の列挙が不正確 / 対応: 直した
- [should][conv:paired-artifact-sync] verify スクリプト・README の「保留」の書き方 / 対応: 直した
- [should][conv:-] 台帳の起票時の記述を取り消し線で残し、起票に設計の材料を書く / 対応: deliver で書く
- [nit][conv:-] dscmd.c の QsnSavScr のログの読み方 / 対応: 書き添えた
- [nit][conv:-] 0x22 の WTD の部分の保留（CFR の読み）/ 対応: research と起票に確かめる旨を書いた
