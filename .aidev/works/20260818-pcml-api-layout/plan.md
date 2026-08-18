# 計画

| # | 段 | 中身 | 確かめ方 |
|---|---|---|---|
| 1 | 出力長 | `ProgramArg` の `bytes` に `outLength?` | 単体（既存は無変更で通る） |
| 2 | 版 | `CommandConnection` に `hostVrm` | 実機で値を見る |
| 3 | 解析 | 名前なし・`outputsize`・`minvrm`/`maxvrm` | **IBM 同梱の 16 本**を固定資料に |
| 4 | 割り付け | 触れない項目を飛ばす・`outLength` を決める | 単体（予約域・受取域） |
| 5 | 配線 | REST が版を取って渡す / 画面が予約域を出す | 単体 |
| 6 | 実機 | `qsyrusri.pcml` のまま QSYRUSRI を呼ぶ | **SR-OSAKA で実体と突き合わせ** |

## 固定資料

`packages/hostserver/test/fixtures/pcml/` に **IBM の原本をそのまま**置く
（`qsyrusri` / `quslfld` / `qszrtvpr` / `qcdrcmdd` / `RUserList` / `RUser`）。
手を入れない——整えると「IBM が配る形」を通したことにならない。

出典と licence（IBM Public License 1.0）はファイル冒頭のコメントに元から入っている。

## 実機での確かめ方

`qsyrusri.pcml` は `USRI0100` 書式で、**受取域 83 バイト**（4+4+10+7+6+1+4+10+8+1+1+4+8+4+1+10）。

```
receiver        struct usri0100  output
receiverLength  int 4  input
format          char 8 input  init="USRI0100"
profileName     char 10 input init="*CURRENT"
errorCode       int 4  input  init="0"
```

`receiverLength=83` を入れて呼び、`userProfile` が実際のユーザー名になることを見る。
`bytesReturned` / `bytesAvailable` も返るので、**83 で足りているか**が数字で分かる。

## 危ないところ

| 危険 | どうするか |
|---|---|
| `outputsize` が小さすぎて出力が切れる | **算出値より小さければ断る** |
| 版が取れないのに `minvrm` がある | **断る**（勝手に通すと本数がずれる） |
| 名前なしを落としてしまう | 単体で「バイトを占める」を固定 |
| 既存 4,382 件 | `outLength` は省略時が今の挙動。解析の追加は新しい属性のみ |
