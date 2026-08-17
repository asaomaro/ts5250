# レビュー

## 作ったもの

**CL コマンドの定義（テンプレート）を引き、値を埋めて、正しいコマンド文字列を作って実行する。**

| ファイル | 中身 |
|---|---|
| `command-template.ts` | `QCDRCMDD` の 2 回呼び出しと XML の解析 |
| `command-build.ts` | 組み立てと検証（**純関数**。ホストに触らない） |
| `command-run.ts` | 取得 → 組み立て → 実行。テンプレートの記憶 |
| `scripts/verify-command-template.mjs` | 実機での確認 |

```ts
await runCommandTemplate(conn, "CRTLIB", { LIB: "ASAOLIB", TEXT: "It's a test" });
// 実行されるのは CRTLIB LIB(ASAOLIB) TEXT('It''s a test')
```

## 原典（AGENTS.md「原典を直読してから設計する」）

JTOpen に「コマンドテンプレート」という名前の機能は**無い**。当たるのは
`com.ibm.as400.access.Command#getXML()` で、これが `/QSYS.LIB/QCDRCMDD.PGM` を呼ぶ。
`refreshXML()` を直読して引数 6 本・2 回呼び・UTF-8 という**手順を事実として写した**
（コードは移していない）。

**jt400 は XML を返すところまで**で、コマンド文字列の組み立ては持たない。
**「テンプレートを使って実行」の実行側は、こちらの足し前**にあたる。

## 効いた判断

### 1. 取得と組み立てを分けた（spec D1）

組み立ては**純関数**なので、テンプレートさえあれば**ホスト無しで全部試せる**。
`formatValue` の規則（引用・特殊値・小文字）は 20 件の単体テストで固定した。

### 2. fixture は実機から採った

`CRTLIB`（3.5KB）と `CPYF`（12KB）の**本物の XML** をテストに置いた。
手で書いた XML では、`Qual` の入れ子や属性の並びを取りこぼす
——実際 `CPYF` の `FROMFILE` は `Type="QUAL"` に `<Qual>` が 2 段入っていて、
これは想像で書けない形だった。

### 3. XML パーサを足さなかった（plan）

`hostserver` は依存を持たない層。相手は `QCDRCMDD` が吐く固定の形なので、
**小さな字句解析**で足りる。ただし `Prompt` に `&` が入るので**実体参照は解く**。

### 4. 生の XML を捨てない（spec D2）

`ELEM` の入れ子や `PmtCtl` は今回解いていない。**取りこぼしを「無かったこと」にしない**ため、
`template.xml` に原文を残して利用者が読めるようにした。

### 5. 小文字を引用する

CL は**引用しない値を大文字に畳む**ので、`TEXT(abc)` は `ABC` になる。
打った通りに入れたいなら囲むしかない——これは机上では気づきにくく、
**実機で読み戻して初めて確かめられる**性質のもの。

## 検証

**実機（社内 IBM i）**——`scripts/verify-command-template.mjs`

| 確認 | 結果 |
|---|---|
| テンプレートが引ける（`CRTLIB` 8 パラメータ） | PASS |
| 組んだコマンドが通る（`TEXT('It''s a テスト lib')`） | PASS |
| **読み戻して一致**（`QSYS2.OBJECT_STATISTICS`） | PASS |
| `runCommandTemplate` の一発呼び出し | PASS |
| 許されない値を**打つ前に**弾く | PASS |

**引用の要る値**（`'`・空白・小文字・日本語）を 1 つの値に全部入れて往復させた。
読み戻した文字列は**打った文字列と完全一致**。

| 項目 | 結果 |
|---|---|
| `npm run build` / `npm run lint` | 緑 |
| hostserver | **892 passed**（新規 20 件込み） |
| server / tn5250 | **1,176** / **451 passed** |

## 残っていること

- **`ELEM` の入れ子**（`KWD((A B) (C D))`）——`QUAL` と繰り返しまでで止めた（spec D4）
- **CL 式**（`&VAR`・`*N`）——値をそのまま置くに留める
- **`CMDD0200`（拡張書式）**——JTOpen も「未対応機では `CPF3C21`」と書いている
- **プロンプト UI**（F4 相当）——テンプレートは材料として揃ったので、要るなら次
