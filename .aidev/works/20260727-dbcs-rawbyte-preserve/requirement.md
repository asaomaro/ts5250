# 要件: DBCS 欄を編集しても SO/SI・全角のバイトを壊さない

## 背景 / 課題

PR #173 の実機検証中に、**報告より深刻な不具合**を発見した。

**DBCS 欄（SEU の日本語ソース行）を 1 文字編集して保存すると、日本語が全部 SUB(0x3F) に潰れる。**

### 実機実測（`TESTLIB/QJPNTEST(JPNATTR)`）

| | バイト列 |
|---|---|
| 編集前 | `C1 C2 28 0E 45E2 45C9 0F C3 C4`（`AB` ＋属性 ＋ SO `設通` SI ＋ `CD`） |
| 2 文字目を B→X しただけ | `3F E7 28 3F 3F 3F 3F 3F 3F 3F 3F` |

属性 0x28 は PR #173 で救われたが、**SO/SI と全角のバイトがすべて失われた**。

### 原因

`fieldValue`（`buffer.ts`）の生バイト分岐に **`!dbcs &&` のゲート**が残っていた。

```ts
s += !dbcs && c.char === UNDISPLAYABLE && c.rawByte !== undefined
  ? rawSentinel(c.rawByte) : c.char;
```

編集後の DBCS 欄は `setFieldValue` によって全セルが「生バイトを持つ SBCS セル」になり、
`hasDbcsStructure` が偽 → この一般経路へ落ちる。DBCS 欄が除外されているため
SO/SI・全角のバイトは U+FFFD のまま返り、送信時に SUB へ化ける。

**このコメント自身が「U+FFFD のまま返すと SUB に化けて元のデータを壊す」と警告している**のに、
DBCS 欄だけ除外されていた。PR #173 が属性について直したのと**同じ形の見落とし**。

## スコープ

- 対象: `packages/core/src/screen/buffer.ts` の `fieldValue` 生バイト分岐
- 対象外: 送信エンコード規則・SO/SI 再構成・表示経路

## 完了条件

- [ ] SO/SI・全角を含む DBCS 欄を 1 文字編集しても、他のバイトが**そのまま**送られる
- [ ] 送信データに SUB(0x3F) が現れない
- [ ] 修正前に落ちる回帰テストがある
- [ ] **実機で round-trip が成立する**
- [ ] build / test / lint / vue-tsc ビルドが通る
