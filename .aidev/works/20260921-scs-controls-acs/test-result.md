# テスト結果: SCS の制御を ACS に合わせる

## 実行したもの
- scs 全テスト 57 passed（新規 16 件）。使う側: server 1454 passed（3 skipped）・hostserver 991・tn5250 のプリンター 9・web-ui のスプール関係 71
- 実採取の帳票の新旧比較（PUB400 の SBCS / DBCS）: 1 桁も変わらない
- 日本語機の DSPLIBL（`scripts/verify-printer-dbcs-push.mjs` で採った生の SCS。実機の識別子を含むのでリポジトリには入れない）:
  先頭の「�」（SBCS の状態の SI）が出なくなった

## 受け入れ基準ごとの判定
- AC1: pass — 制御ごとのテスト 11 件。
- AC2: pass — 2B D1 06（SCG）8 バイト・C1 の長さ・FE・C8・表に無いクラス。
- AC3: pass — 新旧比較で差なし。mutation 10 通りすべて検出（1 回目は TRN を外す改変が生き残った——透過の本体が印字文字だけで
  通常の文字と区別できなかった。本体に 0x0D を混ぜたテストにして検出）。

## 失敗の証跡

```
$ python3 mut-scs.py   # 1 回目
S-d TRN を外す: 32 passed (32)
```
テストの弱さ（上記）。実装の誤りではない。

## 起動確認（smoke）

```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴
- SO/SI の桁・タブ位置・重ね打ち・0xFF は対象外（台帳に残す）。RNL・RFF を含む実際の帳票は見つけていない（D1）。

## ラウンド 2（節目の独立点検の差し戻し後）
- 節目の全量（2026-09-21・14〜17 をまとめて）: root の `npm run build` / `npm test` / `npm run lint` /
  `npm run build -w @ts5250/web-ui` すべて exit 0。
  base 52・ebcdic 100・hostserver 991・scs 71・server 1454（3 skipped）・tn3270 254（38 skipped）・
  tn5250 748・vt 202・web-ui 2270・gen-tables 10 passed（計 6,152 passed / 0 failed / 41 skipped）。
- 1 回目の全量は web-ui の型検査（`vue-tsc -b`）で落ちた——`ShiftMark.width` を必須にしたのに、
  web-ui の `test/` にある手書きの印（2 ファイル）が `width` を持っていなかった（AGENTS.md「root の build は web-ui を検査していない」の実例）。
- mutation（R-a〜R-p のうち 15 通り。R-j は欠番）: すべて検出。このラウンドの対象は R-d〜R-i・R-m・R-n（HT・TRN・GE・BS・SPCC・2B の表）。

### 失敗の証跡（ラウンド 2）

- このラウンドでは、この work の実装の失敗は発生していない（上の型検査の失敗は `20260921-scs-sosi-columns` のもの）。
- 規模（`approve deliver` の累計）: `scs.ts`・`scs.test.ts` の差し戻し分は `20260921-scs-controls-acs` 側に、`spool-html`・`ReportText.vue`・web-ui のテスト・README は `20260921-scs-sosi-columns` 側に数えた（2 つの work の修正が同じファイルに混ざるため）。
