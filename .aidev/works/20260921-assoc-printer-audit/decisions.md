# 決定記録

## D1: `withAudit` でなく `audit()` を直接出し、理由を `code` に載せる
- 背景: 準備の結果は `{ printerId?, closeWithLast, issue? }` で、失敗（使えない・開けない・時間切れ）も例外にならず「関連付けなしで開く」に落ちる。`withAudit` は例外か MCP のエラー応答でしか `error` にしない。
- 決定: `prepareAssociation` の外側で結果から `audit({ op: "ws_associated_printer", result, code?, durationMs })` を 1 回出す。`code` は `issue`（invalid / failed / timeout）。
- 影響: 設定名・装置名・利用者の値は載せない（spec D14）。関連付けを指さない表示では出さない。

## D2: 時間切れの確認は既存の 5 秒のテストに足す
- 決定: 待ち時間の最小は 5 秒（ACS の丸め）なので、時間切れだけ別のテストにすると 5 秒を二重に払う。既存の時間切れのテストに監査の確認を足した。
