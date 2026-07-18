# テスト結果（2026-07-18T16:37:24Z）

## 受け入れ基準の検証

| # | 基準 | 方法 | 結果 |
|---|---|---|---|
| 1 | 接続・認証（TLS/平文） | 実機 | ✅ 9475 / 8475 とも。`as-rmtcmd-s→9475` も確認 |
| 2 | 副作用のない CL が成功 | 実機 | ✅ `CHGJOB CCSID(273)` / `ADDLIBLE`→`RMVLIBLE` |
| 3 | 存在しないコマンドが失敗しメッセージ ID が取れる | 実機 | ✅ `CPD0030` / `CPF0001`（重大度 30） |
| 4 | 実行時エラーのメッセージ | 実機 | ✅ `CPF2110` 重大度 40（severe） |
| 5 | プログラム呼び出しと出力受け取り | 実機 | ✅ `QUSRJOBI` で 200 バイトを取得 |
| 6 | メッセージ解析の単体テスト | 単体 18 件 | ✅ CP 0x1106（実機バイト列）/ 0x1102（合成） |
| 7 | 資格情報が平文で出ない | 実機トレース | ✅ 平文・大文字・UTF-16BE いずれも未出現 |
| 8 | jt400 との対応 | 目視 | ✅ 3 ファイルすべてに参照コメント |

## 実機での確認

```
host=pub400.com tls=true V7R5M0 ccsid=273 dsLevel=11

成功  rc=0x0    CHGJOB CCSID(273)
成功  rc=0x0    ADDLIBLE LIB(MYLIB)      CPC2196 [info/0] Library MYLIB added to library list.
成功  rc=0x0    RMVLIBLE LIB(MYLIB)      CPC2197 [info/0] Library MYLIB removed from library list.
失敗  rc=0x400  NOSUCHCMD                CPD0030 [error/30] Command NOSUCHCMD in library *LIBL not found.
                                         CPF0001 [error/30] Error found on NOSUCHCMD command.
失敗  rc=0x400  DSPLIB LIB(NOSUCHLIB)    CPF2110 [severe/40] Library NOSUCHLIB not found.
```

**成功時にも情報メッセージ（重大度 0）が返る**ことを実機で確認した。
成否は戻りコードで判断する実装になっている（spec D5）。

プログラム呼び出し（`QUSRJOBI` / JOBI0100）:

```
成功 rc=0x0  受信変数 200 バイト
  ジョブ名 = "QZRCSRVS"  ユーザー = "QUSER"  番号 = "682365"  状況 = "*ACTIVE"
```

コマンドサーバー自身のジョブ情報が返っており、出力パラメータの受け渡しが機能している。
**後続 4 件（スプール・MSGW・IFS・各種一覧）はこの上に載る。**

## 自動テスト

| パッケージ | 件数 |
|---|---|
| core | 387（うち本作業の新規 **35**） |
| server | 192 |
| web-ui | 279 |
| **合計** | **858** |

`tsc -b` 通過 / lint クリーン / 既存 823 テストに影響なし。
ピュア層での `Buffer` 等の Node グローバル使用なし（前段 must の再発チェック済み）。

## 環境依存で未検証の範囲（deliver へ引き継ぐ）

- **CP 0x1102（固定長メッセージ）は実機で観測できていない**。合成バイト列の単体テストのみ。
  古いサーバーでしか返らないため、実機で確かめる手段が無い
- **データストリームレベル 10 未満は未対応**（明示的に `HOST_SERVER_UNSUPPORTED`）。
  PUB400 は 11 で、10 未満を確認する手段が無い
- **対話型コマンドは使えない**。`SNDPGMMSG` は `CPD0031 "Command ... not allowed in this setting."`
  で弾かれる。コマンドサーバーの制約であり実装の問題ではない
- **PUB400 以外の IBM i は未検証**
- プログラム呼び出しは読み取り専用 API 1 件のみで確認。入出力パラメータ（inout）は未検証
