# 仕様: WSF D9/72 への応答

## 設計方針
- `applyStructuredField` が D9/72（長さ 6）を拾ってフラグと次のバイトを返し、`ApplyResult.wsfD972` に載せる。
- `query-reply.ts` の `buildWsfD972Reply(flags, next)` が ACS と同じ 2 通りを Query Reply と同じヘッダで組む（0x80 は `undefined`）。
- セッションは Query と同じ場所で応答を送る。0x80 のときは警告だけ（否定応答は未対応）。

## 依拠する既存の事実
- research F1〜F4。Query Reply のヘッダ（`buildRecord(OPCODE.PUT_GET, …, {}, CLIENT_FLAG2)`）は ACS の実機と一致させ済み（`query-reply.ts`）。

## 受け入れ基準との対応
- AC1: `test/alarm-and-query-size-session.test.ts`（2 通りのバイト列）・実機（ホストが読んだ生バイト）
- AC2: 同（0x80・長さ 7）
- AC3: mutation
