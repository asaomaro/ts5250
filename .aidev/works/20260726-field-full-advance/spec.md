# 仕様: 自動送りの判定をカーソル基準に一本化する

## 概要

`ScreenGrid.advanceIfFull` の SBCS / DBCS の分岐をやめ、**カーソルが欄の末尾に届いたか**の 1 条件にする。

```ts
// 変更前
function advanceIfFull(f: Field): void {
  if (!edit) return;
  if (isDbcsEdit(f)) {
    if (dbcsByteLength(editValue(edit).replace(/ +$/, "")) >= visLen(f)) emit("field-full", f.index);
    return;
  }
  if (edit.cursor >= edit.chars.length) emit("field-full", f.index);
}

// 変更後
function advanceIfFull(f: Field): void {
  if (!edit) return;
  if (edit.cursor >= edit.chars.length) emit("field-full", f.index);
}
```

## 設計方針

### 方針 1: 自動送りは「カーソルの話」である

自動送りは「**これ以上この欄に進めない**」ことの通知で、値がどれだけ詰まっているかとは別。
予算基準は「既に埋まっている欄では 1 打鍵目から真」になるため、条件の作りがそもそも誤りだった。

### 方針 2: バイト予算はカーソル基準に吸収される（未確定事項の解消）

DBCS 欄の `chars` は `padDbcs` が「バイト長 ≥ 予算」になるまで空白で埋めた配列。全角入力で予算が
尽きると `absorbDbcs` が末尾の空白を削るので `chars.length` が縮み、**カーソルはその分早く末尾に届く**。
よって予算の分岐を消しても、全角で予算が尽きたときの自動送りは失われない。
既存の DBCS テスト群（上書き・桁幅・ペースト・IME 確定）で裏を取る。

### 方針 3: 呼び出し側は変えない

`advanceIfFull` は打鍵（SBCS / DBCS）と IME 確定から呼ばれる。ペーストからは元々呼ばない
（ACS はペーストで満杯になっても送らない）。この構造は正しいので触らない。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/web-ui/src/components/ScreenGrid.vue` | `advanceIfFull` の条件と意図コメント |
| `packages/web-ui/test/field-full-advance.test.ts`（新規） | 回帰テスト 3 件 |

## 振る舞いの詳細

| 状態 | 打鍵 | 送る? |
|---|---|---|
| 満杯の欄・カーソル先頭 | 1 文字 | **送らない**（変更点。以前は送っていた） |
| 満杯の欄・カーソル末尾まで打ち切り | 5 文字目 | 送る |
| 空欄・4 文字目まで | | 送らない |
| 空欄・5 文字目（末尾） | | 送る |
| DBCS 欄で全角入力し予算が尽きる | | 送る（`chars` が縮みカーソルが末尾に届く） |

## 受け入れ基準との対応

| requirement の完了条件 | 満たし方 |
|---|---|
| 満杯欄で 1 文字打っても送らない | 新規テスト（`dbcsType: "open"` の 5 桁欄・報告の再現） |
| 末尾まで打ち切ったら送る | 新規テスト |
| 空欄は最後の文字でだけ送る | 新規テスト |
| 修正前に落ちる | 修正を外して実行し 1 件が落ちることを確認 |
| 既存テスト全通過 | `cd packages/web-ui && npx vitest run` |
| ビルド | `npm run build -w @as400web/web-ui`（vue-tsc 込み） |
