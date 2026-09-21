# 設計

## 概要
- `fillFollowingSegments(f, fill)`: 継続欄で、カーソルの区間より後ろの区間を全桁 `fill` で直接コミットする（`commitFieldValueDirect`）。Erase EOF・Field Exit・Field±（Field＋）は空白、Dup は Dup 文字。
  カーソルの区間は従来の編集モデルのまま（右寄せもカーソルの区間だけ）。満杯直後の Field Exit（`fieldExited`）は ACS が `eraseToEOF` を通らないので消さない（`erases`）。
- `field-full` に第 3 引数 `leaving`（欄を出る操作）を足し、`onFieldFull` が行き先を `indexAfterLeaving`（継続欄の 2 区間目以降を飛ばし、無ければ先頭へ巡回）で決める。

## 対象範囲
- `packages/web-ui/src/components/ScreenGrid.vue`・`EmulatorPane.vue`、`packages/web-ui/test/continued-field-exit.test.ts`、`scripts/acs-probe/continued-field-erase-exit.txt`、`scripts/build-ulktest.mjs`（CDUP）。

## 依拠する既存の事実
- 継続欄の区間の並びは `continuedRunOf(f)`（`composables/continuedRun.ts` の `runOf`）。`commitFieldValueDirect` は編集モデルを経由しない区間への直接コミット（`ScreenGrid.vue`）。MDT は鎖のどこかに立てば全区間（`mdtOf`）。

## インターフェース / データ構造
- `field-full` の型: `(fieldIndex, viaFieldExit?, leaving?)`。`viaFieldExit` は出た後の検査を掛けない印（Field Exit・Field± のみ）、`leaving` は行き先の規則（Field Exit・Field±・Dup）。

## 振る舞いの詳細
- 継続欄でない欄は、続く区間が無いので消去・埋めは変わらない。行き先は継続欄でない次の欄なら従来と同じ。打鍵の満杯は `leaving` なし＝次の区間。

## エラー処理 / 異常系
- 既存の拒否（MF・Field− の継続欄）は変えない。

## 受け入れ基準との対応
- AC1〜AC4: `continued-field-exit.test.ts` の 16 件（ScreenGrid 9・ペイン 7）。AC4: mutation 18 通り。
