# テスト結果（01-core-dtaq）

subtask 単独で検証できる範囲（unit・偽サーバー・実機 spike）を検証した。
server/web-ui との結合は親の統合 test に委ねる。

## 自動テスト（実機なし）

- **core 全体: 736 passed / 65 files**（`npx vitest run`）。既存 713 を壊さず +23。
- 追加した固定テスト:
  - `test/host-connection-timeout.test.ts`（4）— `request` の `readTimeoutMs`。
    (a) 省略時は接続既定 20 秒のまま＝後方互換 (b) 指定でその往復だけ延びる
    (c) `0` でタイムアウト無効 (d) 上書き後は既定に戻る。遅延応答する偽サーバーで確認。
  - `test/dtaq-datastream.test.ts`（19）— 各ビルダの固定バイト列、`parseReadReply`
    （research F2 の実機ダンプを固定データに）、`parseAttributesReply`、
    `dtaqFailure`/`parseCpfId` の rc+CPF→エラーコード写像。
- lint（eslint）/ build（tsc -b）クリーン。

## 実機検証（PUB400 / MYLIB、spike `npm run dtaq`）

| 項目 | 結果 |
|---|---|
| 接続（0xE007 → 交換属性） | OK |
| FIFO 順序 | first → second → third ✓ |
| LIFO 順序 | c → b → a ✓ |
| キー検索 EQ/GT/LT | val-20 / val-30 / val-10 ✓ |
| ピーク（消費しない） | ✓ |
| 空キュー → undefined | ✓ |
| クリア | クリア後は undefined ✓ |
| 送信者情報 | `QZHQSSRV QUSER … USER` をデコード ✓ |
| 属性取得（FIFO/LIFO/KEYED） | 3 種とも parse 一致 ✓ |
| **無限待ち wait=-1** | 30.3 秒待って遅延投入を受信（改修前は 20 秒で切れていた）✓ |

## 外部ツールでの突き合わせ（独立検証）

`CRTDTAQ MAXLEN(333) SEQ(*KEYED) KEYLEN(7) SENDERID(*YES)` を作り、
- 自前 `attributes()`: `{maxEntryLength:333, type:"KEYED", keyLength:7, saveSender:true}`
- QSYS2.DATA_QUEUE_INFO: `333 / KEYED / 7 / YES`

**完全一致**。属性レイアウトを独立ツールで確認（自前の create+parse が相殺して誤る可能性を排除）。
検証後のキューは削除済み。

## 未検証（親の統合 test / 02 に引き継ぎ）

- **エラー応答 0x8002 の CPF メッセージ位置の実機採取**（存在しないキュー・権限なしを叩く）。
  現状 `parseCpfId` は位置非依存の走査なので位置ずれには強い（decisions D1）が、
  「実際に CPF が載る／拾える」ことは 02 の実機検証で確かめる。
- server 経由の encoding 変換・HTTP ステータス写像・wait 上限は 02 の範囲。
