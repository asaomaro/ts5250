# テスト結果: 自動サインオンの変数

## 実行したもの
- tn5250 `test/telnet.test.ts`（15 件。新規 2・書き換え 1）・`telnet-printer.test.ts`・`printer-session.test.ts` — 34 passed。server の資格情報・自動サインオンに触れるテスト 330 passed
- 実機: `scripts/verify-autosignon.mjs PUB400` → `T13: OK`。`AS400` は変更の前後とも `サインオン画面のまま`（QRMTSIGN `*FRCSIGNON`。D2）
- ACS のワイヤ（タップ）: research F4
- 全量・lint・build は節目でまとめて回す。

## 受け入れ基準ごとの判定
- AC1: pass — バイト列（IBMRSEED の VALUE の後に値が無い）・正規化・エスケープの 3 件。
- AC2: pass — PUB400 で通った。ACS のワイヤも IBMRSEED は値なし・USER は大文字。

## 失敗の証跡

```
$ node --env-file=.env --env-file=.env.verify scripts/verify-autosignon.mjs AS400   # 変更後
T13: NG — サインオン画面のまま（自動サインオン不成立。AS400）
$ git stash push packages/tn5250/src/telnet/telnet.ts && …verify-autosignon.mjs AS400   # 変更前
T13: NG — サインオン画面のまま（自動サインオン不成立。AS400）
```
変更の前後で同じ。手元の実機の QRMTSIGN は `*FRCSIGNON`（SQL で確認）で、自動サインオンを受けない設定。この変更の失敗ではない。

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 45247)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴
- 暗号化の自動サインオン（ACS の既定かもしれない。台帳へ）。パスワードに ASCII 以外の文字がある場合（ACS は既定の文字コードで符号化する）。
