# テスト結果: 帳票の SO/SI を ACS と同じ桁で描く

## 実行したもの
- scs 全テスト 62 passed（旧い「桁を占めない」を前提にした 10 件を ACS の描き方へ書き換え、SPCC の 5 件を追加）。
  使う側: server 1454 passed（3 skipped）・hostserver 991・web-ui のスプール関係 71
- 日本語機の DSPLIBL（生の SCS。リポジトリには入れない）: DBCS の説明（「システム・ライブラリー」）が SBCS の説明より 1 桁右から始まる（ACS と同じ）

## 受け入れ基準ごとの判定
- AC1: pass — 既定 1 桁ずつ・SPCC 00 00 / 00 01 / 00 02 / 00 03・長さ 2 と 3。
- AC2: pass — 印は SO/SI の桁の左端（`left:2ch` / `left:9ch`）。印の有無で行のマークアップは変わらない（既存テスト）。
- AC3: pass — mutation 6 通り（M-a〜M-f）すべて検出。

## 失敗の証跡
このラウンドでは実装の失敗は発生していない（旧い前提のテスト 10 件の書き換えは意図どおり。research F3・decisions D1）。

## 起動確認（smoke）

```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴
- ACS そのものの出力（PDF・印刷）と並べてはいない（原典と、日本語機が送る SPCC の値から決めた）。

## ラウンド 2（節目の独立点検の差し戻し後）
- 節目の全量（2026-09-21・14〜17 をまとめて）: root の `npm run build` / `npm test` / `npm run lint` /
  `npm run build -w @ts5250/web-ui` すべて exit 0。
  base 52・ebcdic 100・hostserver 991・scs 71・server 1454（3 skipped）・tn3270 254（38 skipped）・
  tn5250 748・vt 202・web-ui 2270・gen-tables 10 passed（計 6,152 passed / 0 failed / 41 skipped）。
- 1 回目の全量は web-ui の型検査（`vue-tsc -b`）で落ちた——`ShiftMark.width` を必須にしたのに、
  web-ui の `test/` にある手書きの印（2 ファイル）が `width` を持っていなかった（AGENTS.md「root の build は web-ui を検査していない」の実例）。
- mutation（R-a〜R-p のうち 15 通り。R-j は欠番）: すべて検出。このラウンドの対象は R-a〜R-c・R-o・R-p（SO/SI を空白で書く・冗長な SO・SBCS の状態の SI・印の位置 2 か所）。

### 失敗の証跡（ラウンド 2）

```
$ npm run build -w @ts5250/web-ui   # 節目の 1 回目（該当行の抜き出し）
report-text-shift-marks.test.ts(13,3): error TS2375: Type '{ rows: number; cols: number; lines: string[]; raw: never[][]; shifts: ShiftMark[][] | undefined; }' is not assignable to type 'LogicalPage' with 'exactOptionalPropertyTypes: true'. Consider adding 'undefined' to the types of the target's properties.
view-cascade.test.ts(386,19): error TS2741: Property 'width' is missing in type '{ col: number; kind: 
view-cascade.test.ts(386,43): error TS2741: Property 'width' is missing in type '{ col: number; kind: 
view-cascade.test.ts(410,19): error TS2741: Property 'width' is missing in type '{ col: number; kind: 
view-cascade.test.ts(410,43): error TS2741: Property 'width' is missing in type '{ col: number; kind: 
web-ui build exit=1
```
- 規模（`approve deliver` の累計）: `scs.ts`・`scs.test.ts` の差し戻し分は `20260921-scs-controls-acs` 側に、`spool-html`・`ReportText.vue`・web-ui のテスト・README は `20260921-scs-sosi-columns` 側に数えた（2 つの work の修正が同じファイルに混ざるため）。
