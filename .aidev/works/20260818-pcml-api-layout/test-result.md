# 試験結果

## 実機（）

### 1. IBM の記述のまま API を呼ぶ — **13 PASS / 0 FAIL**

`scripts/verify-pcml-api.mjs`。`jtopen` 同梱の `qsyrusri.pcml` を**1 文字も変えずに**使った。

```
### 1. ホストの版
  V7R5M0（生値 460032）
  PASS signon から版を取れた（minvrm の判定に要る）
### 2. IBM の記述をそのまま解析する
  PASS qsyrusri を読めた
  PASS 受取域は 16 項目
  PASS うち**名前なしの予約域が 2 つ**
### 3. 名前で呼ぶ
  PASS 呼び先 QSYS/QSYRUSRI（小文字の path から解いた）
  PASS 引数は 5 本 / 受取域は出力 83 バイト / 呼び出しが成功
### 4. 返った値
  bytesReturned = "83"      bytesAvailable = "94"
  userProfile   = "USER"    status = "*ENABLED"    badSignonAttempts = "0"
  PASS bytesReturned = 83 / bytesAvailable が受取域以上 / userProfile が一致
### 5. 独立した経路（QSYS2.USER_INFO）と突き合わせる
  SQL: STATUS=*ENABLED / SIGN_ON_ATTEMPTS_NOT_VALID=0
  PASS status が一致 / PASS badSignonAttempts が一致
13 PASS / 0 FAIL
```

**「呼べた」ではなく「正しく返った」を言うために、SQL の経路と突き合わせた。**
予約域を 1 バイトでも取りこぼすと `status` 以降が全部ずれるので、
この一致は**予約域が正しく場所を取っている**ことの証拠でもある。

### 2. 実ブラウザ（Playwright → 実 IBM i）— **13 PASS / 0 FAIL**

`scripts/verify-browser-pcml-api.mjs`。IBM の記述を**貼り付けて**操作した。

```
OK IBM の記述を手を入れずに読める — qsyrusri
OK **名前の無い予約域が画面に出る**
OK **予約域には入力欄が無い** — 入力欄は receiverLength / format / profileName / errorCode だけ
OK 受取域の中は出力なので入力欄が出ない
OK `init` のある入力は既定値が入っている（format=USRI0100）
OK 呼び出しが成功する — 成功（戻り 0） 呼び先 QSYS/QSYRUSRI
OK bytesReturned=83 / userProfile=USER / status=*ENABLED
OK **`outputsize` を持つ記述も読める**（qcdrcmdd）／受取域の長さの既定値 49152
OK **受取域が足りなければ断る** —
   「qcdrcmdd.receiver の受け取る長さ 4 は、記述が要る 8 より小さいです」
13/13 成功
```

## IBM 同梱 16 本のうち、通るようになったもの

| 記述 | 前 | 後 |
|---|---|---|
| `qsyrusri` | ✗ 名前なしで拒否 | **○** |
| `qszrtvpr` | ✗ 同上 | **○** |
| `quslfld` | ✗ 同上 | **○** |
| `qcdrcmdd` | ✗ `outputsize` で拒否 | **○** |
| `RUserList` | ✗ `minvrm` で拒否 | **○**（版を渡せば） |
| `RUser` | ✗ `offset` で拒否 | ✗（**次の作業**。理由を言って断る） |

## 自動テスト

| 対象 | 件数 |
|---|---|
| `hostserver`（`pcml-ibm` 13 を追加） | **929 passed** |
| `server`（版の試験 5 を追加） | **1,193 passed** |
| `web-ui`（予約域の試験 3 を追加） | **1,663 passed** |
| その他 | 617 passed |
| 合計 | **4,401** |

`npm run build`（`vue-tsc` 込み）・`npm run lint` ともに緑。

### 1 件ではなく 2 件、この作業と無関係に落ちる回がある

`zip-writer`（外部 `unzip` を呼ぶ）と `tab-visibility`（`App.vue` ごと組み立てる）が
**5 秒で時間切れ**になる。前作業と同じ**機械の負荷**が原因で、
別プロジェクト（`/workspaces/stock-price-predication`）の vitest が 12 コアを占有していた
（`load average 21`）。**どちらも単独では通る**（確認済み）。触っていないファイル。
