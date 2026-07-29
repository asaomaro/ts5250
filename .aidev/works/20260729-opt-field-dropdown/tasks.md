# タスク: オプション欄に選択肢のドロップダウンを出す

## 第1段: 検出（純関数・実機 fixture で裏取り）

- [x] T1: `legendsInRow` を一般化し `F<n>=` とオプション凡例で共有する（依存: なし）
  - ラベル終端「空白 2 個以上」・`TRAILING_BORDER`・**幅とラベルの同一切り出し**を引き継ぐ
  - `F<n>=` 側の結果が 1 つも変わらないこと
- [x] T2: `detectOptionColumn()` を足す（依存: なし）
  - 同じ桁・同じ長さ（1〜2）の非保護欄が **3 行以上、連続する行に**並ぶ列
- [x] T3: `detectOptionHints()` を足す（依存: T1, T2）
  - Opt 列の最小行より上から凡例を拾う。**両方揃わなければ `null`**
  - 窓が開いていれば窓の中だけ。`(?<![A-Za-z0-9])` で `F3=` を除く
  - 番号が欄の長さに収まらない選択肢は捨てる
- [x] T4: `packages/web-ui/test/opt-legend.test.ts`（依存: T3）
  - 実機 `wrkobjpdm` / `wrksplf` / `dsplibl` で凡例と Opt 列が取れる
  - `wrkmsgq` / `menu` が `null`
  - `F3=` を拾わない

## 第2段: 設定

- [x] T5: `viewSettings.ts` に `optHints` を足す（依存: なし）
  - `VIEW_ITEMS` へ ON/OFF の 2 択（`linkify` と同じ形）。`FALLBACK` の既定は **OFF**

## 第3段: UI

- [x] T6: `ScreenGrid.vue` にポップオーバーを足す（依存: T3, T5）
  - フォーカス中の欄が Opt 列に属するときだけ導線を出す
  - 下矢印 or 印のクリックで開く。`Esc` / 外側クリックで閉じる
  - 選ぶと**既存の入力経路**で番号が入り、フォーカスを欄へ戻す
  - 設定 OFF なら検出も走らせない
- [x] T7: 文言を `opMessages.ts` に置く（依存: T6）
- [x] T8: ScreenGrid のコンポーネントテスト（依存: T6）
  - 設定 OFF で何も出ない / ON かつ Opt 欄フォーカスで出る / 選ぶと値が入る

## 仕上げ

- [x] T9: 空振り検証 — Opt 列の条件を外すと `wrkmsgq` / `menu` のテストが落ちる（依存: T4）
- [x] T10: 既存テスト全通過・`npm run build -w @as400web/web-ui`（vue-tsc 込み）・lint（依存: 全部）
