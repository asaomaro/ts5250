# CL コマンドを「テンプレート」から組み立てて実行する

## 発端

> jt400 でテンプレートを使って CL コマンドを実行できた記憶がある

**原典を読んで確かめた**（AGENTS.md「原典を直読してから設計する」）。JTOpen に
「コマンドテンプレート」という名前の機能は無いが、**それに当たるものはある**——
`com.ibm.as400.access.Command#getXML()` が **`QCDRCMDD`（Retrieve Command Definition）**
を呼び、**CL コマンドの定義を XML で返す**。

**実機で確かめた**（社内 IBM i）。`CRTLIB` を引くとこう返る:

```xml
<QcdCLCmd DTDVersion="1.0">
 <Cmd CmdName="CRTLIB" CmdLib="QSYS" CCSID="37" MaxPos="2" Prompt="Create Library" …>
  <Parm Kwd="LIB"  PosNbr="1" Type="NAME" Min="1" Max="1" Len="10" Rstd="NO"  Choice="Name"/>
  <Parm Kwd="TYPE" PosNbr="2" Type="NAME" Min="0" Max="1" Len="10" Rstd="YES" Dft="*PROD"
        Choice="*PROD, *TEST">
    <SpcVal><Value Val="*PROD" MapTo="PROD"/><Value Val="*TEST" MapTo="TEST"/></SpcVal>
  </Parm>
  <Parm Kwd="AUT" … Dft="*LIBCRTAUT"/> …
```

**これがテンプレート**——キーワード・型・必須かどうか・既定値・桁数・許される値が全部載る。
`CPYF` を引けば `Type="QUAL"` に `<Qual>`（オブジェクト名＋ライブラリー）が入れ子で付く（12,229 文字）。

## 今どうなっているか

`packages/hostserver` には**コマンド実行そのもの**は既にある
（`CommandConnection.run(command: string)`）。**足りないのは組み立て側**。

利用者は**コマンド文字列を自分で組む**しかなく、次を全部自分で正しくやる必要がある:

- キーワードの綴り（間違えれば `CPF0001`。実行するまで分からない）
- **引用符**（`TEXT('...')` の中に `'` が来たら二重化）
- 必須パラメータの抜け
- 値の桁数・許される値（`TYPE(*PRDO)` のような打ち間違い）

**実際にこのリポジトリで踏んでいる**——`scripts/build-empsfl-osaka.mjs` の冒頭に
「日本語ラベルを DDS 定数にすると SO/SI がコマンド行 SQL の引用符入れ子を壊す」と書いてある。
引用の作法を**呼ぶ側が毎回考えている**のが現状。

## やりたいこと

**テンプレートを取ってきて、値を埋めて、正しい CL コマンド文字列を作り、実行する。**

```ts
const tpl = await retrieveCommandTemplate(conn, "CRTLIB");
const cmd = buildCommand(tpl, { LIB: "ASAOLIB", TEXT: "It's a test" });
// → CRTLIB LIB(ASAOLIB) TEXT('It''s a test')
await conn.runOrThrow(cmd);
```

## 満たすこと

1. **テンプレートを引ける**——`QCDRCMDD` を呼び、XML を解いて型のある形にする
2. **コマンド文字列を組める**——キーワードと値から、**引用も含めて正しい**文字列を作る
3. **打つ前に弾ける**——知らないキーワード・必須の抜け・許されない値・桁溢れ
4. **既存の実行経路に載る**——組んだ文字列は `run()` にそのまま渡せる

## やらないこと（今回）

- **プロンプト UI**（F4 相当の画面）——別作業
- **CL 式**（`&VAR`・`*N` の位置指定・計算式）——テンプレートは表現できるが、
  組み立て側は**値をそのまま置く**に留める
- `CMDD0200`（拡張書式）——JTOpen も「システムが対応していないと `CPF3C21`」と書いており、
  必要になってから
- **入れ子の ELEM の完全対応**——まず `QUAL`（`LIB/OBJ`）と繰り返し（`Max>1`）まで

## 受け入れ基準

- 実機で `CRTLIB` / `CPYF` のテンプレートが引け、**パラメータの一覧が型どおりに取れる**
- `TEXT('It''s')` のように**引用が必要な値**が正しく組める
- 知らないキーワードと必須の抜けを**打つ前に**エラーにする
- 組んだコマンドが**実機で通る**（作って消すところまで）
