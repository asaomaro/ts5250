# 仕様: READ の無い WRITE ERROR CODE

## 設計方針
- `ApplyResult.errorCodeWritten` を足し、セッションは READ の無いレコードでも WEC があれば施錠を解いて AID の待ちを画面で解く（保留が始まったときと同じ）。
- `readOutstanding`（ACS `pending_read`）を持つ: READ で立て、AID・PC コマンドの応答を送ったら下ろす。立っていない間の AID（Attn・SysReq 以外）は `deferredAid`（ACS `pending_aid`）に溜め、
  待ち（`pendingAid`）だけ積む。次の READ が来たら**そのときの画面で**組んで送り、待ちはその応答で解く。繋ぎ直しで捨てる。

## 依拠する既存の事実
- READ は `handleRecord` の `readSolicited` で ready にし `pendingAid` を解く（`session.ts`）
- 保留が始まったときの解錠（`20260927-host-error-hold` D4・D6）

## 受け入れ基準との対応
- AC1: `test/wec-only-unlock.test.ts`（research F2）
- AC2: `scripts/verify-wec-only-unlock.mjs`（カーソルの 2 バイトは F3 の既知の差として外す）
- AC3: DLTPGM と IFS の削除
