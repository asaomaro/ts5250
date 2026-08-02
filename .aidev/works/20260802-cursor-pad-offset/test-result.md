# テスト結果: カーソルと文字の位置ずれ

## 自動テスト

| 対象 | 結果 |
|---|---|
| `npm run build`（`tsc -b` ＋ `vue-tsc`） | PASS |
| `npm run lint` | PASS |
| `packages/web-ui`（vitest 全件） | **1,270 passed / 109 files**（本件で +4） |

### 新規テストが本当に効くことの確認

`test/grid-overlay-offset.test.ts` は**わざと壊して落ちることを確かめた**。
`.cursor` の margin を直す前の `8px 0 0 10px` に戻すと:

```
× **余白の px を CSS に直書きしない**
  AssertionError: 余白ぶんの補正は var(--grid-pad-*) から読むこと:
    expected [ '8px 0 0 10px' ] to deeply equal []
```

戻すと 4 件とも PASS。**書き方の検査なので、コメント中の例文は対象外**にしてある
（`styleBlock()` が CSS コメントを落とす。落とさないと注記の `var(--grid-pad-x, 2px)` を
自分で踏む——実際に踏んで直した）。

## 実機検証（実機・実ブラウザ）

`node --env-file=.env scripts/verify-cursor-align.mjs` — **7 passed / 0 failed**

```
### 足場: 行 24 桁 20（字幅 13.00px / 行高 32.50px）
### 1. クリックの桁逆算
  PASS クリックした桁にカーソルが行く（想定 20 / 実際 20）
  PASS クリックした行にカーソルが行く（想定 24 / 実際 24）
### 2. カーソルと文字が重なる（利用者の指摘そのもの）
  PASS **横のずれが無い**（0.00px）
  PASS **縦のずれが無い**（中心の差 0.75px / カーソル 32.5px・字 37.0px）
### 3. 余白の補正が効いている
  PASS 横位置が content box 基準と一致（-0.03px）
  PASS 縦位置が content box 基準と一致（0.00px）
  PASS 幅が 1 桁ぶん（13.00 vs 13.00）
```

### 直す前を実測した（報告のずれ量と一致）

`.cursor` の margin だけ元に戻して web-ui を組み直し、同じスクリプトを流した:

```
### 2. カーソルと文字が重なる
  FAIL **横のずれが無い**（8.00px）
  FAIL **縦のずれが無い**（中心の差 7.75px）
### 3. 余白の補正が効いている
  FAIL 横位置が content box 基準と一致（7.97px）
  FAIL 縦位置が content box 基準と一致（7.00px）
```

**右へ 8px・下へ 7px**——旧値 `10px`/`8px` と新値 `2px`/`1px` の差そのもの。
利用者が見ていたずれの正体がこれで確定した。

## 受け入れ基準

| 完了条件 | 結果 |
|---|---|
| px 直書きが残っていない | ✅ 12 か所すべて var 化。テストが番人になる |
| カーソルがセルに一致（誤差 1px 未満） | ✅ 横 0.00px / 縦（中心）0.75px |
| 直書きが復活したら落ちるテストがある | ✅ わざと壊して落ちることを確認 |

## 途中で踏んだこと（記録）

- **`import.meta.url` は jsdom 環境では file URL ではない**。`fileURLToPath` が
  `The URL must be of scheme file` で投げる。cwd 相対に切り替えた。
- **縦の一致を「上端どうし」で見ると通らない**。`Range.getBoundingClientRect()` が返すのは
  字の inline box で、行box（`line-height: 1.25em`）と高さが違う（実測 32.5px vs 37.0px）。
  中心で比べるのが正しい。最初これで 3.00px の偽陽性を出した。

## 未検証の穴

- 実機で測ったのは**カーソル**だけ。罫線・窓枠・GUI 部品は同じ 1 行の CSS を共有しており、
  カーソルが合えば同じ基準で合う——が、画面に出すには専用の DSPF が要るため測っていない。
