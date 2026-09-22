# 仕様: DBCS の端末タイプ

## 設計方針
- `terminalTypeFor` の DBCS は画面サイズによらず `IBM-5555-C01`。画面サイズの申告は Query Reply に任せる（既存）。

## 依拠する既存の事実
- `query-reply.ts` の t[50] は画面サイズで 0x11 / 0x31（`buildQueryReply`）。型番は端末タイプから取る（`typeAndModel`）。

## 受け入れ基準との対応
- AC1: `terminal-wide.test.ts` と ACS のワイヤ（research F1）。AC2: research F3。
