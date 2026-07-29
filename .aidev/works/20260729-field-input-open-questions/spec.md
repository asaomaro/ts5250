# 仕様: field-input の「要確認」2 件

## 概要

調査で 2 件とも「直すべき」と決まった（`research.md`）。どちらも小さく、互いに独立。

## 設計方針

### 方針 1: 欄の先頭の Backspace は**移動だけ**（削除しない）

原典（GNU tn5250 `kf_backspace`）が欄の先頭で削除していないので、こちらも削除しない。
**破壊的 Backspace（欄の中）は変えない**——PC の利用者が期待する挙動で、
非破壊に変えると既存の操作が全部変わる。

### 方針 2: 許容集合は広げず、**「その欄の現在値にある文字」を通す**

`$` `*` `/` を一律に通すと誤入力も通る。**ホストが書いた文字だけを通す**なら、
「ホストが送ってきた値を送り返せない」という不合理だけが消えて、他は締まったまま。

## 対象範囲

- `packages/core/src/screen/field-validate.ts` — 検証に現在値を渡す
- `packages/core/src/session/session.ts` — 現在値を取って渡す
- `packages/web-ui/src/components/ScreenGrid.vue` — 欄の先頭の Backspace で emit
- `packages/web-ui/src/components/EmulatorPane.vue` — 前の入力欄の末尾へフォーカス

## インターフェース / データ構造

```ts
// core: 第 4 引数に「その欄の現在値」（ホストが書いた内容）
export function validateFieldContent(
  value: string, field: InternalField, codec: Codec, current = ""
): void
```

```ts
// web-ui: ScreenGrid の emit。field-full（次へ）と対になる
(e: "field-prev", fieldIndex: number): void;
```

## 振る舞いの詳細

### B1: 欄の先頭で Backspace

`edit.cursor === 0` のとき、**値を変えずに** `emit("field-prev", f.index)`。
`EmulatorPane` が画面順で 1 つ前の入力欄へフォーカスし、**キャレットを末尾**へ置く。
先頭の欄では末尾の欄へ回る（`onFieldFull` が `(cur + 1) % n` で回っているのと対称）。

SBCS 経路と DBCS 経路の両方に入れる。

### B2: 検証で「現在値にある文字」を通す

数値欄・英字専用欄の許容集合判定で、**その欄の現在値に含まれる文字は違反にしない**。

```
現在値 "$***1,234.56" の欄に "$***1,234.57" を送る → 通る（`$` `*` は現在値にある）
現在値 "1234" の欄に "12$4" を送る               → 弾く（`$` は現在値に無い）
```

DBCS 種別・コードページの検証は**変えない**（別の理由の検証なので）。

## エラー処理 / 異常系

- `field-prev` は**値を変えない**ので MDT は立たない
- 入力欄が 1 つしか無い画面では自分自身へ戻る（実害なし）

## 受け入れ基準との対応

| requirement の完了条件 | 満たし方 |
|---|---|
| 2 件とも根拠つきで結論 | `research.md` F1–F6 |
| 直すものは実装＋テスト | B1・B2 と単体テスト・空振り検証 |
| 直さないものは理由を残す | 該当なし（2 件とも直す） |
| backlog の未着手が 0 件 | 該当項目を結論つきで閉じる |
