# 仕様: DBCS 欄（SEU ソース）の埋め込み属性を編集・送信で失わない

## 概要

属性を**値の中を動く 1 バイト（センチネル）として扱う**という `e9ab19e` の方式を、
DBCS 欄にも適用する。core 3 箇所・web-ui 2 箇所の計 5 点。

```mermaid
flowchart LR
  A["cells<br/>attr セル"] -->|"① fieldValue"| B["値<br/>センチネル"]
  B -->|"② 編集（web-ui）"| C["編集値<br/>センチネル維持"]
  C -->|"③ setFieldValue"| A
  C -->|"④ 送信"| D["生の属性バイト"]
  style B fill:#d4edda,stroke:#28a745
```

③④ は**既にセンチネルを扱える**（`setFieldValue:424` / `read-response.ts:39-45`）。
壊れているのは ① と ②。

## 設計方針

### D1. `fieldValue` の DBCS 例外を外す（core）

```ts
} else if (c?.type === "attr") s += dbcs ? " " : attrSentinel(c.byte);   // 変更前
} else if (c?.type === "attr") s += attrSentinel(c.byte);                // 変更後
```

元コメントの懸念「SO/SI・2 バイトの都合でセンチネルを混ぜると送信エンコードが壊れる」は
**今は成り立たない**。実測で確認した根拠:

- `dbcsRawFieldValue`（未編集で DBCS 構造を持つ欄）は**既に `attrSentinel` を返している**
  （実測: 値は `e0c1 e0c2 e028 e00e e045 e0e2 e00f e0c3 e0c4` ＝ 属性 0x28 がセンチネルで載る）
- 送信（`read-response.ts`）は `isRawSentinel` なら**生バイトを 1 つ書き、前後を別 run として
  encode する**。DBCS/SBCS を問わない
- 属性は**SBCS モードの 1 バイト**なので、全角の間に来ても
  「SI で閉じる → 属性バイト → SO で開く」が正しい。`flushRun` の分割がそれを満たす

つまり DBCS 欄の値にセンチネルが載ること自体は既に成立しており、
**この 1 箇所だけが取り残されていた**。

### D2. snapshot の属性セルに属性バイトを載せる（core）

web-ui が `logicalFromCells` でセンチネルを組み立てるには**属性バイトが要る**が、
現在の `snapshot()` は属性セルを `{ char: " ", kind: "attr", color, … }` として作り、
**バイトを落としている**（`buffer.ts:573-583`）。

`Cell` には表示できない SBCS バイト用の `rawByte?: number` が既にあるので、
**属性セルにも `rawByte: cell.byte` を載せる**。新しいフィールドは増やさない。

### D3. `logicalFromCells` はセンチネルを残す（web-ui）

```ts
else if (cell.kind === "attr") s += " ";                              // 変更前
else if (cell.kind === "attr") s += attrSentinel(cell.rawByte ?? 0);  // 変更後
```

現行コメントは「core の SBCS fieldValue と同じ扱い」と書いているが、
**core は空白ではなくセンチネルを返す**ので記述自体が誤り。合わせて直す。

`attrSentinel`（バイト→文字）は `@as400web/core/browser` から未輸出なので**追加する**
（逆方向の `attrSentinelByte` は既に出ている）。

### D4. `dbcsByteLength` はセンチネルを 1 バイトと数える（web-ui）

`isFullWidth` は**私用領域 U+E000–F8FF を外字＝全角として含む**ため、
センチネルを渡すと **SO＋2 バイト＋SI** と数えて長さ予算が壊れる。
センチネルは 1 バイトを運ぶ印なので **1 バイト**が正しい。

PR #172 で入れた `displayCols`（桁）と**同じ性質の問題**だが、
**共通化しない**——あちらは「画面の桁数」、こちらは「送信バイト数」で、
たまたま今は同じ答えになるだけの別概念。1 つにすると、
片方の都合で他方が動く事故を招く（`MIN_BORDER_RUN` と `MIN_REVERSE_FRAME` を
別名で同じ値にしたのと同じ判断）。

### D5. 表示側の経路は変えない

本修正で DBCS 欄の値にもセンチネルが載るので、将来はオーバーレイを
**値由来（編集に追従）**へ寄せられる。ただし web-ui の DBCS 休止表示は
`dbcsSliceText` がセンチネルを空白へ潰す設計で、そこを変えると表示全体に波及する。
**本作業はデータの保全に閉じる**（PR #172 のセル由来の表示はそのまま機能する）。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/core/src/screen/buffer.ts` | `fieldValue` の DBCS 例外を外す（D1）／ `snapshot` の属性セルに `rawByte`（D2） |
| `packages/core/src/browser.ts` | `attrSentinel` を輸出（D3 のため） |
| `packages/web-ui/src/components/ScreenGrid.vue` | `logicalFromCells` がセンチネルを残す（D3） |
| `packages/web-ui/src/composables/fieldValidate.ts` | `dbcsByteLength` でセンチネルを 1 バイトに（D4） |

### 変更しない

- `dbcsRawFieldValue`（既に正しい）／ `setFieldValue` ／ `read-response.ts`
- SO/SI の再構成規則・DBCS 入力検証の規則
- 表示のオーバーレイ経路（PR #172）

## 振る舞いの詳細

| 状況 | 変更前 | 変更後 |
|---|---|---|
| DBCS 欄（構造なし）の `fieldValue` | 属性が空白 | **属性がセンチネル** |
| 編集を `setFieldValue` で書き戻す | 属性セルが消える | **属性セルが復元される** |
| 送信データ | 属性バイトが落ちる | **属性バイトが桁位置ごと載る** |
| 属性より前を 1 文字削る | 属性が動かない（そもそも無い） | **属性が 1 桁左へ動く**（SBCS 欄と同じ） |
| DBCS 欄（構造あり）の未編集送信 | 変わらない | **変わらない**（`dbcsRawFieldValue` 経路） |
| SBCS 欄 | 変わらない | **変わらない** |

## エラー処理 / 異常系

| 想定 | 扱い |
|---|---|
| 属性セルに `rawByte` が無い（古い snapshot） | `?? 0` でセンチネル 0x00 に落とす。桁は保たれる |
| 属性が全角ランの途中 | `flushRun` が SI で閉じ、属性バイトを出し、SO で開き直す（D1 の実測根拠） |
| 属性を含む値が欄長を超える | `dbcsByteLength` が 1 バイトで数えるので予算計算は正しくなる（D4） |

## 受け入れ基準との対応

| requirement の完了条件 | 満たし方 |
|---|---|
| 編集後も属性セルが残る | D1（値に載る）＋既存の `setFieldValue`（復元済み） |
| 送信に属性バイトが含まれる | D1 ＋既存の `read-response` |
| 属性より前を削ると属性が動く | D1（値の中の 1 文字として動く） |
| `dbcsByteLength(センチネル)` が 1 | D4 |
| SBCS 欄が変わらない | D1 は DBCS 分岐の削除のみ。SBCS の式は不変 |
| DBCS 構造つき欄の送信が変わらない | `dbcsRawFieldValue` に触れない |
| 修正前に落ちるテスト | core（round-trip・送信バイト）と web-ui（`dbcsByteLength`）に追加 |
