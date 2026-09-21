# 仕様: 装置名の展開と答え直し

## 設計方針
- tn5250 に `telnet/device-name.ts`（`DeviceNameGenerator`）。ACS の手順を書き起こし、聞かれるたびに次の名前を出す。`canRetry()` は `=` を含む（か当 PJ の繰り上げが効く）かつ使い切っていないとき。
- telnet は NEW-ENVIRON SEND のたびに `next()` を送る。表示・プリンターは起動応答が 8902 で `canRetry()` なら拒否せず次の起動応答を待つ。
- `deviceNameRetry` は同じ生成器に載せる（記号の無い名前でも末尾の数字を繰り上げる。5 回まで）。サーバーの繋ぎ直しの輪は撤去。
- `&COMPN` / `&USERN` はサーバー（`deviceNameEnvFor`）から渡す——tn5250 は Node の API に触れない。

## 依拠する既存の事実
- 起動応答の解析は `parseStartupResponse`、表示は 1 レコード目だけを見る（`session.ts` の `firstRecord`）、プリンターは `started`。
- 自動再接続（`establish`）は接続ごとに `TelnetLayer` を作り直すので、生成器も接続ごとに作り直される。

## 受け入れ基準との対応
- AC1: `device-name.test.ts`（実測の規則を合成の名前で）
- AC2: `startup-reject.test.ts`「装置名の答え直し」・`printer-session.test.ts`、実機 `scripts/verify-device-name.mjs`
- AC3: 同（`deviceNameRetry`・8906 では答え直さない）
- AC4: mutation
