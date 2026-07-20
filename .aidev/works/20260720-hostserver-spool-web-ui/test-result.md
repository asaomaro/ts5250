# テスト結果

## ラウンド 1（2026-07-20）

**判定: 失敗（1 件）→ coding へ差し戻し**

### 実行環境

- 自動テスト: 各パッケージの vitest（web-ui は `cd packages/web-ui` から）
- 実機: PUB400（`srv:pub400.com`）に対し、リポジトリの dist を
  `--http 3477 --profiles profiles.local.json` でローカル起動して HTTP ルートを直接叩いた
  （認証オフ＝127.0.0.1 のみ待受）。**新規オブジェクトは作成していない**——
  USER 所有の `QGPL/USER` に既存スプールが 3 件あり、そのまま使えた

### 自動テスト

| パッケージ | 結果 |
|---|---|
| core | 663 passed |
| server | 343 passed（新規 21） |
| web-ui | 472 passed（新規 14） |
| `npm run build`（vue-tsc 込み） | 通過 |
| `npm run lint` | 通過 |

skip は 0 件。

### 受け入れ基準の検証

| # | 基準 | 結果 | 根拠 |
|---|---|---|---|
| 1 | OUTQ 指定で一覧が出る | ✅ | `POST /api/host/spools` が 3 件返す |
| 2 | 6 条件で絞り込める | ✅ | `outputQueue`/`outputQueueLibrary`/`status` 併用で 3 件。スキーマ検証は単体テスト 21 件 |
| 3 | 状態が名前で表示 | ✅ | `"status":"READY"`（`statusCode:1` と併記） |
| 4 | テキストが読める | ✅ | 3 ページ・62 行 × 130 桁で取得。桁揃いも保たれている |
| 5 | PDF が保存でき開ける | ✅ | 13,330 バイト・`PDF document, version 1.3, 3 page(s)`。`Content-Type: application/pdf`、ファイル名は `TESTPF-WEBEMUJP-1.pdf` にサニタイズ済み |
| 6 | CCSID が設定から引かれ化けない | ⚠ **部分的** | 経路は単体テストで固定済み。実機の対象スプールが SBCS のみで **DBCS の目視確認ができていない**（下記 skip） |
| 7 | **打ち切りが画面に示される** | ❌ **失敗** | 下記 F1 |
| 8 | 権限不足で原因が分かる | ✅ | 存在しないスプールで `502 {"error":"network print open NOPE#1 failed (rc=0x0009)","code":"PROTOCOL_ERROR"}`。握り潰さずホストの理由が出る |
| 9 | PrinterPane が非退行 | ✅ | web-ui 472 passed（既存分に変更なし） |
| 10 | MCP ツールが非退行 | ✅ | server 343 passed。実機 `host_list_spools` も従来どおり `{items, count}` を返す |

---

## F1（must）: `total` が一致総数を返さない — spec 方針5 の前提が実機で否定された

**該当**: `packages/core/src/hostserver/spool/spool-list.ts`（`LIST_INFO.total` の読み取り）

### 症状

スプールが 3 件ある状態で `max` を変えて実測した結果:

| 要求 `max` | `count` | `total` | `truncated` | 期待 |
|---|---|---|---|---|
| 1 | 1 | **1** | **false** | `total=3` / `truncated=true` |
| 2 | 2 | **2** | **false** | `total=3` / `truncated=true` |
| 3 | 3 | 3 | false | 一致（偶然） |
| 100 | 3 | 3 | false | 一致 |

**`total` は常に `returned` と同じ値になる。**
QGYOLSPL のリスト情報 offset 0 は「条件に一致した総数」ではなく
「この要求で組み立てられた件数」を返している（オープンリスト API は非同期に構築するため、
要求分しか作られていない時点では総数が確定していないと考えられる）。

### 影響

**打ち切りを検出できない**（受け入れ基準 7 が満たせない）。
`truncated` が常に false になるため、利用者は「先頭 N 件しか見ていない」ことに気づけず、
**全件見たと誤解する**。偽陰性なので黙って害が出る種類の欠陥である。

### なぜ単体テストで捕まらなかったか

`packages/core/test/spool-list.test.ts` は `listInfo(1234, 1)` のように
**`total ≠ returned` の応答を人工的に作って**渡している。実機ではその状態が発生しないため、
テストは緑のまま前提の誤りを通してしまった。

> AGENTS.md「実機検証を単体テストの代替にしない」がそのまま当てはまる事例。
> `LIST_INFO.total` は定義されてはいたが**一度も使われたことがない**フィールドで、
> 「定義されている＝期待どおり動く」と推測したのが誤りだった（research R1 で
> 「実機でしか確かめられない」と挙げていたリスクが的中した）。

### 対応（plan R1 の退避策を発動する）

plan.md R1 に定めた退避策へ切り替える:

> もし total が使えないと判明したら `max + 1` 方式（spec 方針5 の代替案）へ退避する。
> この退避は共有関数 `listSpools` の内部に閉じるため、**HTTP/UI の契約は変えずに済む**。

具体的には:

1. `listSpooledFiles` の `total` を**廃止するか、意味を正しく表す名前に改める**
   （`returned` と同義なら返す価値がない）。
2. `host-spools.ts` の `listSpools` で **`max + 1` 件を要求し、`> max` なら打ち切りと判定**、
   返す `items` は先頭 `max` 件にする（`host-sql.ts:219` と同じ考え方）。
3. HTTP の応答から `total` を落とすか、`total` の意味を
   「最低でもこれだけある」に変えて UI 文言を「先頭 N 件のみ表示しています」に合わせる。
   **UI に「1234 件中」と出せなくなる**ので、spec 方針5 の記述と
   `SpoolPane.vue` の表示文言、および `spool-pane.test.ts` の期待値も直す必要がある。
4. `spool-list.test.ts` の `total` 系テストを、実機の挙動に合わせて書き直す
   （人工的な `total ≠ returned` を前提にしない）。
5. spec.md 方針5 と decisions.md に**否定された前提として記録を残す**
   （次に同じ field を見た人が同じ推測をしないように）。

---

---

## ラウンド 2（2026-07-20）

**判定: 合格**

F1 に対し decisions.md D4 の修正（`max + 1` 方式への退避、core 変更の巻き戻し）を適用して再検証した。

### 実機での再検証（PUB400・スプール 3 件）

| 要求 `max` | `count` | `truncated` | 判定 |
|---|---|---|---|
| 1 | 1 | **true** | ✅ 打ち切りを検出 |
| 2 | 2 | **true** | ✅ |
| 3 | 3 | **false** | ✅ ちょうど全件（オフバイワンなし） |
| 100 | 3 | false | ✅ |

**受け入れ基準 7 を満たした。** ラウンド 1 で偽陰性だった箇所が正しく true を返す。

### 非退行（実機）

| 項目 | 結果 |
|---|---|
| 本文取得 | 3 ページ・従来どおり |
| PDF | `PDF document, version 1.3, 3 page(s)` |
| HTTP 応答の形 | `{count, items, truncated}`（`total` が消えている） |
| MCP `host_list_spools` | `{items, count}` のまま（`truncated` を漏らしていない） |

### 自動テスト（ラウンド 2）

| パッケージ | 結果 | 差分 |
|---|---|---|
| core | 662 passed | −1（`total` のテスト 4 件を実態に合わせ 3 件へ） |
| server | 347 passed | +4（`max + 1` の境界: ちょうど / 超過 / 未満 / 0 件） |
| web-ui | 472 passed | 増減なし（期待文言を修正） |
| build（vue-tsc 込み）/ lint | 通過 | |

skip 0 件。

### 受け入れ基準の最終状態

10 項目中 **9 件合格・1 件部分的**（#6 の DBCS 目視のみ下記 skip）。

---

## 環境依存で未検証（skip）— deliver に引き継ぐ

- **DBCS の PDF 目視（plan R5）**: 実機で使えたスプール 3 件はいずれも
  SBCS（英数字のみの Data Description リスト）で、**日本語を含む PDF を確認できていない**。
  CJK フォントの読み込み自体は成功している（`renderSpoolPdf` の warn が出ていない）が、
  「日本語が正しく出る」ことは未確認。
- **権限不足（FORBIDDEN）の実機再現**: 他人のスプールを指定する試験は行っていない
  （PUB400 で他ユーザーのスプールに触れる手段がなく、無用な権限違反を起こさないため）。
  存在しないスプールでのエラー伝播は確認済み。
