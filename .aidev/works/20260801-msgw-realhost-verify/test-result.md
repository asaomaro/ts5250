# 検証結果: MSGW の実機検証

実施 2026-08-01。実機 **実機（IBM i 7.3・平文）**。
再現は `scripts/research-msgw.mjs`。

## 実機（8 項目すべて PASS）

```
プリンター起動: I902 device=PRT_TEST
  QPRTLIBL#180 status=MESSAGE_WAIT form=AIDEVMSGW outq=PRT_TEST
  PASS 検証対象のスプールが見つかる
  PASS 状態が MSGW（実際: MESSAGE_WAIT）

### retrieveMessage
  id=CPA3394
  text=(G B I H R C)装置PRT_TEST書き出しプログラムPRT_TESTの用紙タイプ'AIDEVMSGW'をロードしてください。
  handle=24 バイト
  PASS メッセージ ID が取れる（CPA3394）
  PASS 本文に装置名が読める形で入る（CCSID が合っている）
  PASS ハンドルが返る（これが無いと応答できない）

### answerMessage
  PASS answerMessage が成功する（NUL 終端の応答が受理された）
  PASS MSGW が解けている
  PASS 応答後にスプールが届く（実際: 1 件)

OK — 8 passed, 0 failed
```

## 受け入れ基準ごと

| 基準 | 結果 |
|---|---|
| MSGW のスプールを実機で作れている | 合格（`MESSAGE_WAIT` / `CPA3394`） |
| `retrieveMessage` が ID・本文・ハンドルを返す | 合格（ハンドル **24 バイト**） |
| **`answerMessage` の NUL 終端が受理される** | **合格**——最大の懸念だったが**実装は正しかった** |
| 応答後に MSGW が解け印刷まで進む | 合格（一覧から消え、プリンターセッションが 1 件受信） |
| 実機に残留が無い | 合格（ライター 0 件 / OUTQ のスプール 0 件を SQL で確認） |
| build / lint / test | 合格（**3,310 件通過・失敗 0**） |

## 見つけて直した欠陥

**メッセージ本文が化けていた。** `decodeNpString` が CCSID 37 決め打ちで、
サーバー CCSID 5035 の日本語が読めていなかった。

```
（修正前）text=(G B I H R C)çqãðPRT_TESTå¸àgáºàýäPä]äBäÝäw...
（修正後）text=(G B I H R C)装置PRT_TEST書き出しプログラムPRT_TESTの用紙タイプ'AIDEVMSGW'をロード…
```

**ID は英数字なのでどの CCSID でも読める**——だから「メッセージが無い」経路の確認や
ID の比較テストでは**一度も表面化しなかった**。本文を実際に読んで初めて分かる種類の欠陥。

## 途中で踏んだこと

- **`OVRPRTF` の対象ファイル名**を `QPDSPLIB` と書いていた。`DSPLIBL OUTPUT(*PRINT)` が
  作るスプールは **`QPRTLIBL`**。上書きが効かず用紙タイプが揃ったままで、
  ライターがそのまま印刷して MSGW にならなかった（OUTQ が空になって気づいた）
- **一覧の状態名は `MESSAGE_WAIT`**（画面表記の `MSGW` ではない）。最初の判定が外れた
- **テストの DBCS バイト列を推測で書いて外した**。codec で符号化して確かめ直した

## 未検証の穴

- **PUB400（7.5）では確認していない**（権限不足で MSGW を作れない）。
  版数差の影響は不明
- **応答文字列が長い場合**は試していない。今回は `"I"` の 1 文字。
  「MSGREPLY が固定長を要求するなら隣の値を巻き込む」という当初の懸念は
  **1 文字では起きないことしか示せていない**
- **`decodeNpString` の既定（37）で読む他の経路**（`errorFromReply` の CPF メッセージ）は
  そのままにした。**この work で確かめていない経路**を巻き込んで変えない判断
- 装置は `PRT_TEST` を借りた。**他の装置・他人の OUTQ では試していない**
