# 計画

## 手順

1. **A（前提が成り立たない）から片づける** — 判定を足すだけなので影響が読みやすい
   （`output-dir` / `print-dest` / `printer-output` / `printer-output-windows`）
2. **B（検出の誤り）** — `zip-writer` の `python3`
3. **C（テストが壊れている）** — `.gitattributes` ＋ 作業ツリーの再正規化
4. `packages/server` が緑になったら、**残りの workspace を 1 つずつ回す**
   （server しか測っていないので、他は未知）
5. 出てきたものを C / B に振り分けて直す
6. `npm test` ・ `npm run lint` ・ `npm run build` で締める

## 順序の理由

- **`.gitattributes` は最後の方に置く。** 作業ツリー全体のバイトが変わるので、
  先に入れると「テストが直ったのか、改行が変わったせいか」が混ざる
- **他パッケージは server を緑にしてから**。`server` は外部コマンド依存が最も多く、
  ここで種類の分類（A/B/C）が固まる

## 作業ツリーの再正規化の手順（間違えると作業が消える）

`git checkout-index -f -a` は**効かない**（index の stat が一致していると書き直さない）。
**先にコミットしてから** `git rm --cached -r . && git reset --hard` の順で回す。
未コミットの変更があるときにこれをやると消えるので、順序を守る。

## リスク

- **Linux を壊す**。→ 変更は `skipIf` の追加とパスの正規化に限り、
  既存の判定式には触らない。`skipIf(win32)` は Linux では従来どおり走る
- **`.gitattributes` が既存の登録内容を書き換える**。→ `--renormalize` で差分が出ないことを
  確かめる（`.ucm` は `-text` で除外。実際 2 ファイルが引っかかったので除外の書き方を直した）
- **skip が増えて「緑だが何も見ていない」になる**。→ skip には理由と代替の見張りを書く。
  件数も test-result に残す
