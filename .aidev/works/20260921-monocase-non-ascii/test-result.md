# テスト結果: SBCS のセッションの打鍵と MONOCASE

## 実行したもの
- web-ui の関係するテスト（受け付けの判定・貼り付け・MONOCASE・DBCS の編集を含む 23 ファイル）— 460 passed / 0 failed。
  新規: `field-validate.test.ts` の「SBCS だけのセッション」4 件・`sbcs-session-input.test.ts` 3 件・`ffw-behavior-bits.test.ts` 4 件（保留していた 1 件を含む）。
- tn5250 のブラウザ入口の走査（`ebcdic-not-reexported` ほか 4 ファイル）92 passed。web-ui の `vue-tsc`（test 込み）・変更したファイルの lint 通過。
- 実機（PUB400・ACS のコア）: `scripts/acs-probe/monocase-non-ascii.txt`——コマンド行は `aéñøüµß` のまま、利用者名（MONOCASE）は `AÉÑØÜµß`。
- 全量は次の節目でまとめて回す（PR #410 の方針）。

## 受け入れ基準ごとの判定
- AC1: pass — 判定の単体（Ambiguous を通す・漢字かなは弾く・バイト長）とペイン（37 は通す・930 と不明は従来どおり）。
- AC2: pass — グリッドの打鍵（SBCS の MONOCASE で `aéñøüµßα` → `AÉÑØÜµßΑ`、DBCS のセッションでは Ambiguous の字を大文字にせず弾く）。実機と一致。
- AC3: pass — mutation 12 通りすべて検出（`scratchpad/mut-mono.py`）。

## 失敗の証跡

```
$ npx vitest run test/ffw-behavior-bits.test.ts   # SBCS のセッションを渡しただけの版
Expected: "AÉÑØÜµßΑ"
Received: "AÉÑØÜµ"
```
打鍵の判定は直したが、欄のバイト予算（`dbcsByteLength`）が同じ Ambiguous を SO/SI＋2 バイトで数えて、10 桁の欄が途中で満杯になっていた。予算もセッションを見るようにした。

```
$ node ... scripts/acs-probe.mjs scripts/acs-probe/monocase-non-ascii.txt PUB400   # 最初の 3 回
サインオンできませんでした（パスワード欄が残っている。…）
```
プローブの `signon`（欄へ直接書く）が PUB400 で通らなかった（打ってから消しても、最初の手順にしても）。都度 `verify-autosignon.mjs PUB400 clear` で成功の
サインオンをして失敗回数を数え直し、ACS の自動サインオン（`PROBE_BYPASS_SIGNON=encrypted`）で繋いで測った。原因は追っていない。

## 起動確認（smoke）

```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴
- SBCS のセッションでコードページに無い字を ACS が送るときのバイト（置き換え）は未確認。当 PJ は送信時に拒否する（D1・台帳）。
- 実ブラウザの IME・デッドキーで打った `é` は試していない（jsdom の keydown まで）。
- プローブの `signon` が PUB400 で通らない原因。
