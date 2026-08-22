# レビュー

## 要件との突き合わせ

| 完了条件 | 判定 | 根拠 |
|---|---|---|
| 全 workspace のテストが Windows で緑 | ✅ | `npm test` で failed 0（test-result.md の表） |
| lint ・ build が緑 | ✅ | `npm run lint` / `npm run build`（vue-tsc 込み）ともに error 0 |
| Linux 側を壊していない | ⚠ 未実測 | 変更は `skipIf(win32)` の追加・パスの正規化・`mkdtempSync` への置換のみで、**Linux の経路に条件を足していない**。CI（Linux）で確認する |
| skip の理由が読めば分かる | ✅ | 16 件すべて内訳を表にし、コードにも「代わりに何が見ているか」を書いた |
| backlog が根拠つきで閉じる | ✅ | 11 件を `- [x]`、新たに見つかった 2 件も `- [x]` で追記、残り（Windows の CI）は `- [ ]` |

## いちばん重い発見

**`packages/ebcdic` のバンドル・ガードが Windows で fail-open していた。**
`startsWith("tables/")` が `\` 区切りでは常に false になるため、
「web-ui のバンドルに DBCS 表 600 KB が混ざらないこと」を守るはずのガードが、
Windows では**表に到達していても通る**状態だった。

これに気づけたのは、**同じ suite に「検査が実際に効いている」対照が書かれていたから**。
対照が無ければ「Windows でも緑」で終わっていた。
AGENTS.md の「空振り検証」の考え方が、OS 差という別の軸で効いた例として記録しておく。

## 自分で気になった点（と処置）

1. **skip が 16 件に増えた。** 「緑だが見ていない」を招く。
   → 内訳を test-result に表で残し、コードにも代替の見張りを指した。
   backlog に「CI で Windows を回して skip を減らす」を `- [ ]` で残した
2. **`.gitattributes` は影響範囲が広い**（全ファイルのチェックアウト）。
   → 登録内容は変えていない（`git status` clean）。原典 `.ucm` は `-text` で除外し、
   バイナリは明示した。理由（バイト指紋の検査）をファイル冒頭に書いた
3. **`print-dest` を suite ごと飛ばしたので、Windows では 6 件が完全に無検証になる。**
   → CUPS 経路なので Windows に該当する実装が無い。win32 分岐の検証は
   `printer-output-windows.test.ts` にあり、双方のコメントで相互に指した
4. **`tls.test.ts` は `openssl` が無ければ suite ごと飛ぶようになった。**
   → 以前は ENOENT で落ちていた（環境が無いのに「TLS が壊れた」と読める）。
   飛ばした事実は vitest の skip に残る
5. **`mkdtempSync` への置換で一時ディレクトリーを消していない**（元の `mktemp -d` も
   消していなかった）。→ この作業では挙動を揃えるに留めた。OS の一時領域なので害は小さい

## 差し戻しなし

指摘 1〜5 は記録で処置済み。製品コードは 1 行も触っていない（decisions D6）。
