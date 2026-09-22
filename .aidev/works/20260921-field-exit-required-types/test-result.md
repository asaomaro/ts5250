# テスト結果: Field Exit 必須の欄を ACS と同じく扱う

## 実行したもの
- web-ui 全量 `npx vitest run` — 2246 passed / 0 failed
- 本 work のテスト: `ffw-behavior-bits.test.ts`（RZ・RB・RZ＋自動 Enter の 3 件）・`aid-field-exit-required.test.ts`（場合 10・11 の 2 件）

## 受け入れ基準ごとの判定
- AC1: pass — RZ・RB（自動 Enter 付きも）は満杯でも field-full も aid も出さない。
- AC2: pass — RZ を 6 桁まで打てば Enter が送られる。符号付きは数字桁 5 桁を埋めても 0020 で送られない。
- AC3: pass — mutation F1（判定を FER ビットだけに戻す）→3 件 / F2（境界で待ちを外さない）→1 件が落ちた。
  F3（符号付きの除外を外す）は生き残り、除外は不要と分かったので外した（D1）。

## 失敗の証跡
このラウンドでは失敗が発生していない。

## 起動確認（smoke）

```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実ブラウザ・実機での確認は未実施（jsdom。ACS 側は `20260921-aid-without-field-exit` の実測を使った）。
- 満杯で留まるカーソルの位置が ACS と 1 桁違う（D3）。そこでさらに打ったときの ACS は未測定。

## ラウンド 2（独立点検の指摘の対応後）

### 実行したもの
- `npm test`（全ワークスペース）— tn5250 726・server 1454（3 skipped）・web-ui 2267（1 件は旧挙動を固定していたテストを
  ACS の実測に合わせて書き換えた後に再実行して通過）ほか全部緑。`npm run lint`・root の `npm run build`・web-ui の
  `npm run build`（`vue-tsc` の test 込み）も通過
- 実機の ACS: `scripts/acs-probe/field-exit-full.txt`（場合 A〜H）・`scripts/acs-probe/window-error.txt`（挿入モードと Tab を足した分）

### 失敗の証跡

```
$ npm test   # 1 回目（web-ui）
 FAIL  test/field-keystroke-rules.test.ts > ScreenGrid: 打鍵 > 符号付き数値欄: 7 桁目（符号桁）に数字は入らない
AssertionError: expected [ Array(1) ] to include '符号桁には数字を入力できません（符号は - / + キーで入れます）'
 Tests  1 failed | 2266 passed (2267)
```
旧挙動（数字桁を埋めると符号桁へ出る）を固定していたテスト。ACS は最終の数字桁に留まって次の文字を 0018 にする
（実機で確認）ので、そのように書き換え、符号桁に直接カーソルを置いた場合の拒否は別のテストに分けた。

### 起動確認（smoke）

```
$ aidev smoke
smoke: pass (exit 0)
```

### 受け入れ基準ごとの判定（ラウンド 2）
- AC2: pass — 符号付き数値も数字桁をすべて打てば Enter が通る（1 桁でも残れば 0020）。
- AC4: pass — 満杯の後: 最終桁に留まる・文字は 0018（値は不変）・左矢印は動かない・Backspace の後は 0020・Field Exit / Field− は
  最終桁を消さない・右矢印で境界へ出てから Backspace でも 0020。
- AC5: pass — Dup は FER・RZ・符号付き数値の欄でも次の欄へ。
- AC3: pass — mutation F-a〜F-g の 7 通りすべて検出（Dup で留まる 3 件・fieldAt に戻す 1 件・最終桁で留めない 5 件・左矢印 1 件・
  Field Exit 1 件・0018 1 件・Field− 1 件が落ちた）。

### 未検証の穴
- 実ブラウザでの操作確認は未実施（jsdom）。継続欄（EDTMSK）・DBCS 欄・貼り付けで最終桁まで埋めたときの「出た」状態は未対応。
