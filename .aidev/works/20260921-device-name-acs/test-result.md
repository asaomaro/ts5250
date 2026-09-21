# テスト結果: 装置名の展開と答え直し

## 実行したもの
- tn5250 全量 — 795 passed / 0 failed（`device-name.test.ts` 18 件・`startup-reject.test.ts` の答え直し 4 件・`printer-session.test.ts` 2 件を含む）。
- server — `device-name-env.test.ts`（4 件）・`session-manager.test.ts`・`config*.test.ts` 139 passed / 0 failed。型検査（server）・lint（変更したソース）通過。
- 実機（PUB400・当 PJ のコア）: `scripts/verify-device-name.mjs` **pass=5 fail=0**（小文字 → 大文字の装置・`<名>0` を掴んだまま `<名>=` → 同じ接続の中で `<名>1`・
  記号の無い名前は 8902 で断る・`deviceNameRetry` は繰り上げて繋がる・プリンターの `%=` が I902）。
- 実機（PUB400・ACS のコア・タップ）: research F3〜F5。
- 節目（マイルストーン 7）の独立点検への対応後: 全量 6,349 passed / 0 failed / 41 skipped（1 回目は下の証跡の 1 件が時間切れ。直して server を回し直した）・lint・build（vue-tsc 含む）通過。mutation 24 通り（`scratchpad/mut-m7.py`）と当て直し 2 通りをすべて検出。
- スプール救出の OUTQ（`test/rescue-device-name.test.ts`）・WS からのプリンターの `deviceNameRetry`（`ws-lifetime.test.ts`）・答え直しの最中の時間切れ・切断（`startup-reject.test.ts`・`printer-session.test.ts`）は単体。

## 受け入れ基準ごとの判定
- AC1: pass — 生成器の単体（大文字化・`%`・`*`・`&` の文字落ち・`+` の左右・`=`・36 進・使い切り・`İ`）と実機。
- AC2: pass — 表示とプリンターの答え直し（8902 → 次の名前 → 次の起動応答を起動応答として受け取る）、記号の無い名前は拒否。実機。
- AC3: pass — `deviceNameRetry` は同じ接続の中で繰り上げ、8906 では答え直さない。実機。
- AC4: pass — mutation 24 通りすべて検出（`scratchpad/mut-dev.py` ほか）。「大文字化なし」は最初、置換の文字列が合わず当たらなかったので当て直した。

## 失敗の証跡

```
$ python3 mut-dev.py   # 「次の起動応答を見ない」を足す前のテスト
SURVIVED 次の起動応答を見ない :: 72 passed (72)
```
2 回目の起動応答をデータとして解析しても、時間切れで終わるので区別できなかった。起動応答として受け取った（`startup response I902` の警告）ことと
解析器の警告が出ないことまで見る形にして検出した。

```
$ npx vitest run test/device-name-env.test.ts   # 最初の版
TypeError: mgr.openSession is not a function
```
テストの書き誤り（表示を開くメソッドは `open`）。

```
$ python3 mut-m7.py   # 節目の対応の 1 回目
SURVIVED 時間切れで閉じない :: 46 passed (46)
```
交渉の時間切れで接続を閉じることを見るテストが無かった（時間切れの順序を入れ替えたときに気づいた）。`startup-reject.test.ts` に足して検出。

```
$ npm test   # 節目の最終の全量（1 回目）
 FAIL  test/printer-hold-response.test.ts > 再試行は失敗した出力だけ・切断後は再試行できない > **成功した PDF は再試行で書き直さない**（失敗した印刷だけやり直す）
Error: Test timed out in 5000ms.
      Tests  1 failed | 1494 passed | 3 skipped (1498)
```
この work の変更ではない（マイルストーン 6 のテスト）。PDF を描いて `lp` を 2 回起こすので単独でも 1.3 秒かかり、全量の並列の負荷で既定の 5 秒を超えた
（単独では 3 回とも通った。その前の全量でも通っていた）。describe に 30 秒を明示し、server を全量で回し直して 1495 passed。

## 起動確認（smoke）

```
$ aidev smoke
smoke: 20260921-device-name-acs
smoke: /healthz ok, / が Web UI を返した (port 45043)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴
- 社内機では当 PJ の実装を流していない（新しい装置名は自動構成が効かない実機がある。8902 の後に SEND が来ることは前に確かめた）。
- `=` が 2 つ以上のときの桁の順は原典の読み（乱数の位置から始まるので、衝突を起こして確かめられない）。
- ACS の GUI のセッション名（`*`）の割り当て（D4）。
- 答え直したのにホストが聞き直してこない場合は、実機では起こせない（両方の実機とも聞き直してくる）。単体まで。
- `PRT%=` のような記号入りの名前でスプール救出を実機で回していない。
