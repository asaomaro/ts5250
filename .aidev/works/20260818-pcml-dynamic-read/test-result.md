# 試験結果

## 実機（SR-OSAKA）

### 1. 飛び先つきの記述を読み切る — **7 PASS / 0 FAIL**

`scripts/verify-pcml-dynamic-osaka.mjs`。IBM の `RUser.pcml`（`USRI0300`）をそのまま使った。

```
### 2. 呼ぶ
  PASS 受取域は出力 1526 バイト（outputsize="receiverVariableLength" の init）
  PASS 呼び出しが成功
### 3. 先頭から順に解く
  bytesReturned = "784"   bytesAvailable = "784"   userProfileName = "ASAO"
  offsetToArrayOfSupplementalGroups = "0"   numberOfSupplementalGroups = "0"
  offsetToHomeDirectory = "722"   offsetToLocalePathName = "774"   lengthOfLocalePathName = "10"
  補助グループ（0 件） = []
  PASS **出力で決まる件数**ぶん読めた（0 / 0）
  ホームディレクトリ CCSID=1200 / 長さ=20 / 値="/home/***"
  PASS **飛び先の先**（ホームディレクトリ）を読めた
  PASS **出力で決まる長さ**が効いている
  ロケール名 = "*SYSVAL"
### 4. 独立した経路（QSYS2.USER_INFO）と突き合わせる
  PASS **ホームディレクトリが一致**
7 PASS / 0 FAIL
```

**飛び先（722）・長さ（20）・CCSID（1200）のどれか 1 つでも間違えば一致しない。**
この一致が算法の正しさの証拠になる。

### 2. 実ブラウザ（Playwright → 実 IBM i）— **8 PASS / 0 FAIL**

`scripts/verify-browser-pcml-dynamic-osaka.mjs`

```
OK **件数が出力で決まる行は「呼ぶまで分かりません」**
OK しおり（長さ 0 の名前なし項目）は（予約）として出る
OK 呼び出しが成功する — 成功（戻り 0） 呼び先 QSYS/QSYRUSRI
OK **飛び先の先（ホームディレクトリ）が読める** — /home/***
OK 値が実体と合う
OK **出力で決まる CCSID がそのまま見える** — CCSID=1200（UTF-16）
OK 飛び先の値も読める — offsetToHomeDirectory=722
OK **出力で決まる長さ**（ロケール名）が読める — *SYSVAL
8/8 成功
```

## IBM 同梱 16 本すべてが解析できる

```
OK NetServer / RJavaProgram / RJob / RJobList / RJobLog / RMessageQueue
OK RPrinter / RPrinterList / RSoftwareResource / RUser / RUserList
OK qcdrcmdd / qsyrusri / qszrtvpr / quhrhlpt / quslfld
16 OK / 0 NG
```

## 「結果が変わっていない」ことの確認

計画の 3 で書いたとおり、**`offset` を含まない記述の結果は 1 バイトも変わってはならない**。

`pcml-layout.test.ts` / `pcml-ibm.test.ts` / `host-pcml.test.ts` / `pcml-pane.test.ts` は
**読み取りを逐次解析に差し替えたあとも無変更で通った**（落ちたのは
「`offset` を断る」と書いてあった 2 件だけで、これは仕様どおり）。

## 自動テスト

| 対象 | 件数 |
|---|---|
| `hostserver`（`pcml-read` 18 を追加） | **952 passed** |
| `server` | **1,193 passed** |
| `web-ui`（件数の出力解決 3 を追加） | **1,665 passed** |
| その他 | 617 passed |
| 合計 | **4,427** |

`npm run build`（`vue-tsc` 込み）・`npm run lint` ともに緑。

`zip-writer` と `tab-visibility` が時間切れで落ちる回があるのは前 2 工程と同じ
（別プロジェクトが 12 コアを占有。どちらも単独では通る。触っていないファイル）。
