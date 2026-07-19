# テスト結果

## 自動テスト

```
tsc -b        通過
eslint .      クリーン
vitest core   519 tests（新規 11）
vitest server 271 / web-ui 393（変更なし）
```

マスクと切り詰めを型で固めた——**診断のために入れた機能が漏洩経路にならない**ことが
この作業の最重要事項なので、実機の目視だけに頼らない。

- `0x1105`（パスワード置換値）が `<masked N bytes>` になり、**生の値が 1 バイトも出ない**
- 他の CP と混在してもパスワードだけ伏せる
- 長い値を切り、`…(+N bytes)` と**切った量を明示**する
- 短すぎるフレーム・壊れた LL でも**例外にしない**（トレースは副次機能）
- `isDebugEnabled()` が false なら**整形もしない**

## 実機検証（PUB400・TLS・`LOG_LEVEL=debug`）

```
[debug] hostserver-signon: send len=52 reqrep=0x7003 0x1101=00000001 0x1102=0002 0x1103=0e74…
[debug] hostserver-signon: recv len=94 reqrep=0xf003 0x1101=00070500 0x1119=03 0x111f=…
[debug] hostserver-signon: send len=80 reqrep=0x7004 0x1113=000004b0 0x1105=<masked 20 bytes> 0x1104=e4e2c5d9…
[debug] hostserver-signon: recv len=133 … 0x111a=<masked 20 bytes> 0x112a=0000
[debug] hostserver-db:     send len=64 reqrep=0x7002 0x1105=<masked 20 bytes> 0x1104=…
[debug] hostserver-db:     send len=184 reqrep=0x1803 0x3807=34b00064005300450…(+40 bytes) 0x3809=80
[debug] hostserver-command: send len=28 reqrep=0x7001
```

**読んで切り分けに使える内容**である（受け入れ基準）——サーバー ID・reqrep・
CP ごとの値が並び、どこまで進んだかが追える。DDM 実装中に使い捨てスクリプトで
やっていたことが、環境変数 1 つで済む。

### 実機で見つけた問題 1: CLI がログを出せなかった ★

**最初の実行でトレースが 1 行も出なかった。**

原因は作業 3（`20260719-core-debt-payoff`）でロガーを注入式にしたこと。
core は既定で黙り、`main.ts` が `setLogSink` で注入する設計にしたが、
**`tools/hostserver-check` は注入していなかった**。

つまり**障害切り分け用の CLI が、いちばん切り分けに使いたい情報を出せない**状態だった。
作業 3 の設計が生んだ実際の穴で、**この作業をやらなければ気づかなかった**。

→ `tools/hostserver-check/src/log-init.ts` を追加し、各サブコマンドの先頭で読み込む。
   pino は使わず stderr に素で出す（CLI に依存を増やさない／stdout は結果用なので汚さない）。

### 実機で見つけた問題 2: 正体不明の 20 バイト

signon の応答に **CP `0x111A` の 20 バイト**（SHA-1 と同じ長さ）が載っていた。

**正体を特定できなかった。** 原典（jtopenlite の `SignonConnection`）もこの CP を
解析せず読み飛ばしており、意味を確かめる手段が無い。

→ **伏せる側に倒した。** 認証応答に含まれるハッシュ長の値について、
   伏せて失うのは診断項目 1 つ、伏せずに間違えるとトークンをログに残す——**損得が非対称**。
   「分からないから出しておく」ではなく「分からないから伏せる」を選び、
   理由をコードに書いた。正体が分かったら見直す（backlog に記録）。

## 未検証の範囲

- **DDM のトレースは入れていない**（フレーム形式が違い別実装が要る。spec D3）
- 5250 側（`trace/`）との統合はしていない。別の仕組みのまま
- 大量のフレームが流れる場面（大きな結果セット）でのログ量は実測していない。
  64 バイトで切ってはいるが、行数そのものは制限していない
