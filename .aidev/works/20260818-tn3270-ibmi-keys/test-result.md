# 試験結果

## 実機（）— **10 PASS / 0 FAIL**

`scripts/verify-3270-keys.mjs`

```
### 1. ホストの見分け
  PASS NEW-ENVIRON を交渉した＝IBM i と判定（isIbmI=true）
  PASS TN3270E ではない（isTn3270e=false）——見分けに使えないことの確認
  PASS サインオンしてメニューに着いた
### 2. F キー
  PASS **F4（プロンプト）が効く** → 活動ジョブ処理  (WRKACTJOB)
  PASS 「機能キーは使用できません」が出ない
  PASS **F12（取り消し）が効く** → MAIN  IBM I メインメニュー
  PASS **F13（情報援助）が効く** → INFO  情報援助オプション
### 3. ページ送り（素の PF7 / PF8）
  PASS PF8 で次ページへ進む / PASS 拒否されない
  PASS **F3（終了）が効く**
10 PASS / 0 FAIL
```

**直す前は F3 が「機能キーは使用できません。」だった。**

## 実ブラウザ（Playwright → 実 IBM i）— **4 PASS / 0 FAIL**

`scripts/verify-browser-3270-keys.mjs`

```
OK メインメニューに着く
OK **F4（プロンプト）が効く**（「活動ジョブ処理 (WRKACTJOB)」の画面が出る）
OK **「機能キーは使用できません」が出ない**
OK **F12（取り消し）が効く**
```

⚠ 最初 3 件落ちたが、**判定の書き方の問題**だった——3270 の各桁は `<input>` の値なので
`innerText` に載らない。値も集めるように直したら全部通った（この落とし穴は前にも踏んでいる）。

## 自動テスト

| 対象 | 件数 |
|---|---|
| `tn3270`（`ibmi-keys` 7 を追加） | **245 passed / 37 skipped** |
| `server`（`ws-tn3270` を書き換え） | **1,206 passed** |
| `web-ui`（`aid-3270-mapping` を書き換え） | **1,681 passed** |
| その他 | 617 passed |
| 合計 | **4,738 passed / 37 skipped** |

`npm run build`（`vue-tsc` 込み）・`npm run lint` ともに緑。

**メインフレーム側は無変更で通った**——`tn3270` の TK4- 向け試験（37 件の skip を含む）を
1 件も書き換えていない。`isIbmI` が false の経路に手を入れていないことの裏付け。

`tab-visibility` が 1 件、負荷で時間切れになるのは前工程からの持ち越し
（別プロジェクトが 12 コアを占有。`--testTimeout=30000` で通る）。
