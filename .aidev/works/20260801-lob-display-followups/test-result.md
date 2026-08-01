# 検証結果: LOB 表示まわりの follow-up 3 件

実施 2026-08-01T09:32:04Z。実機は使わない（型と CSV 表現の変更のみ）。

## 全体

| 検証 | 結果 |
|---|---|
| `npm run build`（`tsc -b`） | 通過 |
| **`vue-tsc -b`（web-ui・SFC テンプレート込み）** | **通過**（decisions D1。着手直後は 2 種類のエラー） |
| `npm run lint` | エラー 0 |
| `npm test` | **3,285 件通過 / 失敗 0**（新規 2 件を含む） |

`vue-tsc` の基準線も確認した——`git stash` で変更を退避して回すと **exit 0**。
つまり出た 2 種類のエラーは**本変更が持ち込んだもの**で、直したのも本変更（既存の未修正ではない）。

## 受け入れ基準ごとの検証

### 1. 述語型に `Uint8Array` と 3 値 union が含まれる — 合格

`isLob` の述語を `LobPlaceholder`（`@as400web/hostserver` から `import type`）に変えたので、
`value?: string | Uint8Array` / `unavailable?: "not-requested" | "too-large" | "failed"` が
そのまま効く。**同じ形を 2 か所に書かない**ので、二度と食い違わない。

`packages/hostserver/src/index.ts:48` に `LobPlaceholder` を追加（`DbValue` だけでは
その一員に絞れないため）。

### 2. `as` キャストが消える — 合格

| 場所 | 変更前 | 変更後 |
|---|---|---|
| `csv.ts:21` | `(value as { value?: unknown }).value` | `value.value` |
| `SqlResultTable.vue:78` | `v as { value?: unknown; unavailable?: string }` | `isLob(v)` で絞る |
| `SqlResultTable.vue:89` | `v as { byteLength?: number; unavailable?: string }` | 同上 |

`csv.ts:18` の `(value as { kind?: string }).kind` は**残す**——型ガード自身が
`unknown` から判別子を読む実装で、問題にしていた「絞った後に読み直す」とは別物（decisions D3）。

### 3. CSV に打ち切りの印 — 合格（新規 2 件）

| テスト | 固定した内容 |
|---|---|
| 上限で打ち切ったなら画面と同じ印 | `先頭だけ` → `先頭だけ…（以降省略）` |
| 本文は捨てない・囲みは印まで含める | `x,y` → `"x,y…（以降省略）"`（RFC 4180 のクォートが印まで及ぶ） |

### 4. 他の CSV 表現が変わらない — 合格

PR #240 で入れた 5 件（取得済み / エスケープ / `not-requested` / `failed` / 空欄にしない）が
**無変更で通っている**。

### 5. 画面の表示を変えていない — 合格

`sql-pane.test.ts` **45 件を 1 件も変更せずに通した**。LOB 関連の 3 件
（`not-requested` のツールチップ / `failed` の本文 / `failed` の案内文なし）を含む。
`lobText` / `lobTitle` は引数の型と絞り方だけが変わり、文言・分岐の順序は 1 文字も変えていない。

### 6. 未使用 import が無い — 合格

`SqlPane.vue:8` の `isLob` を削除。`npm run lint` エラー 0。

## 未検証の穴

- **実ブラウザでの確認はしていない**。ただし変更は型注釈と CSV の文字列組み立てのみで、
  画面側は jsdom のテスト 45 件が挙動を固定している
- **バイナリ LOB（`Uint8Array`）の CSV・画面表示は `(LOB)` のまま**で、
  取得に成功していても未取得と区別が付かない（decisions D4）。
  backlog の「BLOB（バイナリ）と中身のある DBCLOB での検証」で実物を見てから決める
- **`too-large` の実データは作っていない**。テストは `unavailable: "too-large"` を
  手で組んだ値で、ホストが実際に打ち切ったときの `value` の中身は見ていない
