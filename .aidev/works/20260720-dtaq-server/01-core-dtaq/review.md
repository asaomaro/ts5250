# レビュー（01-core-dtaq）

subtask 単独のレビュー。**最大の risk は transport 改修**（signon/SQL/IFS/command/netprint が
共有する）なので、独立レビュー（別エージェント）を transport + datastream に当てた。

## ラウンド 1（独立レビュー + 自己レビュー）

### transport（host-connection.ts）/ frame-trace.ts — 指摘なし

独立レビューで 5 点を確認:
- (a) `opts` 省略時は `override=false`・`restore` は no-op・`socket.setTimeout` を呼ばない
  → 既存呼び出しとバイト単位で同一（後方互換）
- (b) タイムアウト復元は resolve/reject の両ラッパで実行。`pending` はこの 2 経路でしか
  クリアされないので、次要求へタイムアウトが漏れない
- (c) `readTimeoutMs: 0` → `socket.setTimeout(0)`（Node のタイマー無効。無限待ち）
- (d) `rejectIfUnusable` が同期で先に走り、単一 in-flight ガードで同時上書きが起きない
- (e) desync 機構は無影響。`traced()` は `opts` を素通しする

### must: なし

### should（2 件・**このラウンドで修正・再検証済み**）

- **S1 `decodeEbcdic` が末尾スペースでなく '@' を落としていた**（`dtaq-datastream.ts:98`）。
  `.replace(/\x40+$/u, "")` はデコード**後**の Unicode 文字列に対して走る。EBCDIC 0x40 は
  デコード後 U+0020 になっており、`\x40` は '@'(U+0040) を指す。フィールドが詰めスペース無しで
  '@' 終端のとき '@' を取りこぼす（CCSID273 の '@' は 0xB5。variant 文字の罠と同型）。
  **修正**: `.replace(...)` を削除し `trimEnd()` だけにした。回帰テスト
  `decodeEbcdic([0xc1,0xb5]) === "A@"` を追加（旧コードは "A" を返す＝テストが効く）。
- **S2 `commonReplyRc` に長さガードが無い**（`dtaq-datastream.ts`）。`replyId` は length>=20 しか
  保証しないが rc は offset20-21（>=22 必要）。20-21 バイトの 0x8002 フレームで生の RangeError が
  飛び、server が分類できない。**修正**: length<22 で `As400Error("PROTOCOL_ERROR")` を投げる。
  回帰テスト追加。

### 確認済み・指摘なし

各ビルダの LL/CP と宣言長の整合、`parseReadReply` の offset58 走査（境界安全・無限ループなし）、
`parseCpfId` の走査、`TYPE_FROM_BYTE` の nibble 写像、`dtaq-types.ts`（純粋型）。

## 結果

- must 0 / should 2（いずれも修正・再検証済み）/ nit 0
- core 739 passed、lint / build クリーン
- 修正は datastream 内に閉じ、transport・connection の挙動は変えていない
