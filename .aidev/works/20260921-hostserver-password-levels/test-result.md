# テスト結果: ホストサーバーの認証の置換値

## 実行したもの
- hostserver 全量 — 1006 passed / 0 failed（新規 `hostserver-password-levels.test.ts` 9 件。telnet の `bypass-signon.test.ts` も ACS の出力と一致のまま）。lint 通過。
- 期待値: ACS に同梱の jt400 を Java から実行（`scratchpad/jth/Jt.java`。jar・出力はリポジトリに入れない）。
- 実機: PUB400（QPWDLVL 3）・社内機（QPWDLVL 0）でサインオン・サーバーの認証と DB サーバーの開始が通った（`scratchpad/hs-levels.mjs`）。
- 全量は次の節目でまとめて回す。
- 節目（マイルストーン 8）の独立点検への対応後: 全量 6,403 passed / 0 failed / 41 skipped・lint・build 通過。実機（PUB400 レベル 3・社内機 レベル 0）でサインオン・DB サーバーの開始・IFS・コマンド・**DDM の握手**が通った
  （社内機の DDM は以前は断っていた）。jt400 の `DDMACCSECRequestDataStream`・`DDMSECCHKRequestDataStream`・`SignonExchangeAttributeReq`・`AS400XChgRandSeedDS` を CFR で読んで値を合わせた。
  テスト（SECMEC・属性・データストリーム・レベル）を足し、mutation 4 通り検出。DDM の置換値の共用は単体では落とせない（ネットワークが要る）ので実機の握手で確かめた。

## 受け入れ基準ごとの判定
- AC1: pass — レベル 4 の 3 例が jt400 と一致、開始要求・サインオン要求（偽のサーバー）とも種別 7・置換値 64 バイト。
- AC2: pass — レベル 0 の `1pass`（Q）、2/3 の末尾の空白、4 の末尾の空白（落とさない）、`*` と空。
- AC3: pass — 実機 2 台の回帰。mutation 11 通りすべて検出（`scratchpad/mut-hsl.py`）。

## 失敗の証跡

```
$ for args in "4 USERA Secret  " ...; do java ... Jt $args; done   # 期待値を採った 1 回目
4 USERA Secret   => 12951be3...（末尾の空白なしと同じ）
```
シェルの語分割で末尾の空白が落ちていた（jt400 のせいではない）。引用して採り直すと別の値（`fd1d668c...`）になり、レベル 4 は落とさないことが分かった。

## 起動確認（smoke）
```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴
- レベル 4 の実機・数字で始まるパスワードの実機は無い（D2）。
