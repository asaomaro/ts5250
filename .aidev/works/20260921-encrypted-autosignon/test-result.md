# テスト結果: 暗号化した自動サインオン

## 実行したもの
- hostserver 全量 — 997 passed（`bypass-signon.test.ts` 6 件: ACS の `PasswordSubstitute` を Java から呼んだ出力とレベル 0〜4 でバイト単位に一致）。
- tn5250 全量 — 798 passed（`telnet.test.ts` の暗号化 3 件: IS の形・IS を送るまで後続に答えない・シード無し / 失敗でパスワードを送らない）。
- server 全量 — 1491 passed / 3 skipped（`bypass-substitute.test.ts` 6 件: 問い合わせは 1 回・聞けなければ 0・表示とプリンターに渡す）。
- 型検査（hostserver・tn5250・server）・lint（変更したソース）通過。
- 実機: `scripts/verify-autosignon.mjs PUB400`（暗号化・QPWDLVL 3）**3 回 OK**（修正の前の 1 回は NG——下の証跡）、社内機（QPWDLVL 0・`*FRCSIGNON`）は
  平文のときと同じくサインオン画面（自動サインオンそのものを受けない機）。ACS のコア（タップ）: research F4。
- 計算の突き合わせ（実物）: タップで採ったホストのシードと当 PJ の IS から、同じ入力で ACS の `PasswordSubstitute` を呼び、**EQUAL**（値は出していない）。

## 受け入れ基準ごとの判定
- AC1: pass — レベル 0〜4 の ACS の出力と一致、実物の入力でも一致。
- AC2: pass — telnet の単体と実機（IS は IBMRSEED＝8 バイト・IBMSUBSPW＝20 バイト。平文は送っていない）。
- AC3: pass — サーバーの単体と実機（PUB400 のレベル 3 を聞いて通った）。
- AC4: pass — mutation 19 通りすべて検出（2 通りは最初、置換の文字列が合わず当たらなかったので当て直した）。

## 失敗の証跡

```
$ node --env-file=.env --env-file=.env.verify scripts/verify-autosignon.mjs PUB400   # 最初の版
送り方: 暗号化（代替パスワード）
T13: NG — サインオン画面のまま（自動サインオン不成立。PUB400）
```
IS の形と計算は ACS と同じだった（タップで確認・計算は EQUAL）。並びを見ると、IS がホストとの BINARY・EOR の交渉の後に届いていた——代替パスワードの計算
（とレベルの問い合わせ）を待つ間に後続の交渉へ答えていた。IS を送るまで受信を溜め、レベルは接続の前に聞き始める形にして通った（D4）。
直後に平文で 1 回成功させて、サインオン失敗の回数を持ち越さないようにした（社内機も同じく画面から 1 回成功させた）。

```
$ npx vitest run   # server。QPWDLVL の差し替え口を入れる前
 × 照会が 1 件なら ユーザー・番号 を足す 5004ms（ほか 5 件）
```
記録のホストの SEND にシードがあり暗号化の経路に入って、架空のホストのサインオン・サーバーへの問い合わせを待っていた。問い合わせに 5 秒の上限と差し替え口を付けた。

## 起動確認（smoke）

```
$ aidev smoke
smoke: 20260921-encrypted-autosignon
smoke: /healthz ok, / が Web UI を返した (port 46355)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴
- QPWDLVL 4 の実機（手元は 0 と 3。ACS の出力との一致まで）。社内機（0）は `*FRCSIGNON` のため DES の代替パスワードがホストに受け入れられるところは見られない
  （DES の計算そのものはホストサーバーのサインオンで実機に通っている）。
- サインオン・サーバーに届かない環境（レベル 0 として計算する＝ACS と同じ。レベル 2 以上のホストでは自動サインオンが通らない）。
