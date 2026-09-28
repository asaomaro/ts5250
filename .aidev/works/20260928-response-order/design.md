# 仕様: 応答をコマンドの順に送る

## 概要
`applyDataStream` がレコードの中で応答の要る命令に出会うたび、`responses`（順序つきの一覧）へ種類を積む。session はこの順に応答を組んで送る。オペコード 04 で `04 02` から始まる長さ 4 以上のデータは、先頭の 2 バイトだけを流す。

## 設計方針
今の真偽値・配列（`saveRequests`・`wsfReplies`・`read*Requested`）は残し（ほかの箇所が読む）、送る順だけを新しい一覧で持つ。応答の中身の組み方は変えない（対象外）。

## 依拠する既存の事実
- 応答を送る位置と順: `session.ts` の `for (const req of result.saveRequests)` 〜 `sendNegative()`
- READ SCREEN 系は真偽値で 1 回だけ送っている（同じレコードに 2 回来ても 1 本）——この決めは変えない（順の一覧でも最初の 1 回だけ送る）
- オペコードごとの読み始め: `streamOf`（`session.ts` 冒頭）

## インターフェース / データ構造
```ts
type ResponseKind = { kind: "save"; index: number } | { kind: "wsf"; index: number } | { kind: "read-screen-ext" | "read-immediate" | "read-mdt-imm-alt" | "read-screen" };
ApplyResult.responses: ResponseKind[]
```

## 受け入れ基準との対応
- AC1: `responses` が [wsf, save] の順になり、session がその順に送る。入力は RESPORDER のレコード（research F1）
- AC2: session がオペコード 04＋`04 02` を先頭 2 バイトだけ流す（ACS `tokenizeData` の case 4）
- AC3: `scripts/verify-response-order.mjs`（当 PJ のコアを relay 越しに実機へ当てる）
- AC4: 既存テスト
