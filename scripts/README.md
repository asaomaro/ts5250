# 実機 E2E / 診断スクリプト

`packages/core` の `Session5250`（および MCP/WS）を実 IBM i（既定 pub400.com）に対して動かす E2E・診断スクリプト。

## 実行方法

ビルド後、資格情報を環境変数で渡して実行する（`.env` は gitignore、パスワードはコミットしない）:

```sh
npm run build
node --env-file=.env scripts/<name>.mjs
```

必要な環境変数: `PUB400_USER` / `PUB400_PASSWORD`（自動サインオン）。任意: `PUB400_HOST`（既定 pub400.com）、
`PUB400_DEVNAME`、`PUB400_LIB`（既定 MYLIB）。各スクリプトは成功で終了コード 0、失敗で 1。

> PUB400 は切断後もデバイスをしばらく保持するため、同名デバイスへの即再接続は
> `closed during negotiation` になりやすい。E2E 系はリトライごとにデバイス名を変える。

## 表示属性 E2E（DBCS・文字色・背景色・属性）

`MYLIB` に作った DDS 表示ファイル `CLRTDSP` ＋ RPGLE `CLRTPGM` を使い、エミュレーターの属性デコードを検証する。

| スクリプト | 内容 |
|---|---|
| `build-attrtest.mjs` | `MYLIB` に `CLRTDSP`/`CLRTPGM` を作成・コンパイル（冪等）。ソースはコマンド行から `RUNSQL INSERT` で投入（IFS 不要）。 |
| `verify-attributes.mjs` | `CALL MYLIB/CLRTPGM` し、7 色・反転(背景)・下線・高輝度・桁区切り・点滅・DBCS(日本語) を検証（18 項目）。DBCS を出すため **CCSID 1399** で接続。 |

```sh
node --env-file=.env scripts/build-attrtest.mjs    # 初回/再作成（既存なら不要）
node --env-file=.env scripts/verify-attributes.mjs # 検証（CLRTPGM が存在する前提）
```

補足: 実機では素の `DSPATR(BL)` はホストが赤・非点滅(0x28)を送るため、点滅は `COLOR(RED) DSPATR(BL)`(0x2A) で検証する。
CLRTDSP/CLRTPGM は E2E 再利用のため MYLIB に残置している。

## その他

`verify-autosignon` / `verify-signon` / `verify-mcp` / `verify-ws` / `verify-browser` / `verify-dbcs-tls` /
`verify-gui-enhanced`（各機能の実機検証）、`capture-*`（トレース fixture 採取）、`diag-*`（signon/PDM 診断）、
`dump-screen`（トレースをオフライン再生）も同じ実行規約に従う。
