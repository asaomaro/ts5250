# 仕様: CL コマンドのテンプレート

## 1. 置き場所——`packages/hostserver/src/command/`

`command-template.ts`（取得と解析）と `command-build.ts`（組み立て）に分ける。
**取得と組み立てを別ファイルにする**のは、組み立てが**ホスト無しで試せる**ようにするため
——テンプレートさえ手元にあれば、文字列を作る規則は単体テストで全部押さえられる。

## 2. 取得

```ts
retrieveCommandTemplate(conn, "CRTLIB", { library: "QSYS" }): Promise<CommandTemplate>
```

`QCDRCMDD` を **2 回**呼ぶ（1 回目で必要な長さ、2 回目で本体）。XML は UTF-8。

`library` の既定は **`*LIBL`**。JTOpen は呼び出し側にライブラリーを書かせるが、
利用者が `QSYS` を知っている必要はない——**見つからなければホストが `CPF` で言ってくる**。

## 3. 型

```ts
interface CommandTemplate {
  name: string;              // CRTLIB
  library: string;           // QSYS
  prompt?: string;           // "Create Library"
  maxPositional: number;     // MaxPos
  parameters: CommandParam[];
  xml: string;               // **生の XML も持つ**（下記）
}
interface CommandParam {
  keyword: string;           // LIB
  type: string;              // NAME / CHAR / DEC / QUAL / ELEM …
  position?: number;         // PosNbr
  required: boolean;         // Min >= 1
  maxValues: number;         // Max（2 以上なら繰り返し）
  length?: number;           // Len
  restricted: boolean;       // Rstd === "YES"
  default?: string;          // Dft
  prompt?: string;
  /** `SpcVal` の `Val`（`*PROD` など）。`restricted` の判定に使う */
  specialValues: string[];
  /** `Type="QUAL"` のときの各段（オブジェクト名・ライブラリー…） */
  qualifiers?: CommandParam[];
}
```

**生の XML を捨てない**——こちらが解いていない属性（`ELEM` の入れ子・`PmtCtl` 等）を
利用者が自分で読めるようにする。取りこぼしを「無かったこと」にしない。

## 4. 組み立て

```ts
buildCommand(tpl, { LIB: "ASAOLIB", TEXT: "It's a test" })
// → "CRTLIB LIB(ASAOLIB) TEXT('It''s a test')"
```

**値の書き方**（実測で確定させる。research F5）:

| 値 | 出力 | 理由 |
|---|---|---|
| `*PROD` のような `*` 始まり | そのまま | 特殊値 |
| 英数字と `.`/`_`/`/` だけ、かつ**大文字** | そのまま | 名前・数値はそのままでよい |
| それ以外（空白・小文字・記号） | `'…'` で囲む | CL の文字定数 |
| 値の中の `'` | `''` に二重化 | 文字定数の中の引用符 |

**配列**は繰り返し（`KWD(A B C)`）。`Max` を超えたら拒否。

## 5. 打つ前に弾くもの

| 弾く条件 | エラー |
|---|---|
| テンプレートに無いキーワード | `FIELD_NOT_FOUND` |
| `required` なのに値が無い | `CONFIG_ERROR` |
| `restricted` なのに `specialValues` に無い値 | `FIELD_TYPE` |
| `length` を超える値 | `FIELD_OVERFLOW` |
| `maxValues` を超える個数 | `FIELD_OVERFLOW` |

**弾く方を厚くする**のが今回の値打ち——`run()` に投げれば実行できてしまうので、
**打つ前に分かること**をこちらで全部言い切る。

## 6. 実行

```ts
runCommandTemplate(conn, "CRTLIB", { LIB: "X" })   // 取得 → 組み立て → run
```

**テンプレートは覚える**（同じ接続で 2 回目以降は取り直さない）。
コマンド定義は実行中に変わらない。

## 決定

- **D1**: 取得（ホスト要）と組み立て（純関数）を**分ける**。組み立てはホスト無しで試せる
- **D2**: **生の XML を残す**。解いていない属性を利用者が読めるように
- **D3**: **打つ前の検証を厚く**。知らないキーワード・必須の抜け・許されない値・桁溢れ
- **D4**: `ELEM` の入れ子は**今回入れない**。`QUAL` と繰り返しまで
- **D5**: テンプレートは**接続ごとに覚える**（コマンド定義は動かない）
