# レビュー記録（02-server-mcp）

## ラウンド 1（2026-07-15）

subtask 02 の単独レビュー（server コード＋core 追補）。要件・仕様・規約・保守性の観点。

- [should] `packages/server/src/mcp-tools.ts` 監査ログがツールエラー時も result:"ok" になる / 対応: 修正
  - **内容**: 各ツールは内部 `try/catch` で `errorResult(err)`（値）を返すため、`withAudit` は正常終了とみなし
    `result:"ok"` を記録する。ツールがクライアントに isError を返した場合でも監査上は成功扱いになり、
    監査証跡（spec D14）の正確性を損なう（「あの操作は成功したか？」を誤らせる）。
  - **修正**: `withAudit` が返り値を検査し、`isError === true` なら result:"error"＋error code を記録するようにする。
    errorResult の structuredContent に code を持たせて拾う（error 応答は outputSchema 検証対象外＝実機で確認済み）。

- [nit] `Session5250.findCommandField`（core）はコマンド行を「最後の非保護・非 hidden 入力フィールド」と推定する。
  複数入力フィールドを持つ画面ではコマンド行以外を選ぶ可能性がある（メニュー等の典型ケースは正しい。
  decisions D2 に前提を明記済み）/ 対応: 許容（限定は文書化済み）。
- [nit] fetchJobInfo の F3 復帰は best-effort（DSPJOB 以外の想定外画面では確実な復帰を保証しない）/ 対応: 許容。
- [nit] エラー応答（isError）の structuredContent は outputSchema と形が異なるが、SDK は error 応答を検証しない
  ことを実機で確認済み（不正 sessionId で get_screen → isError:true・例外なし）/ 対応: 問題なし。

判定: should 1 件 → coding へ差し戻し。

## ラウンド 2（2026-07-15・差し戻し後の再レビュー）

- [should] 監査ログの ok-on-error → **修正済み**。`withAudit` が返り値の `isError` を検査し、
  error 応答も result:"error"＋code を記録するようにした。ユニット 2 件追加、実機で
  `get_screen`（不正 sessionId）が `result:"error", code:"SESSION_NOT_FOUND"` になることを確認。
  全 117 テスト合格、実機 MCP E2E 維持。
- must/should なし。nit（findCommandField 推定・F3 best-effort）は許容（decisions に文書化済み）。

判定: 指摘解消。review 通過。

