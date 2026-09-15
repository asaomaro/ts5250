# レビュー: `field-validate.ts` を ACS の `Field5250` と突き合わせる

## タスク点検ログ

- [must][conv:comment-provenance!] T1: `field-validate.ts` の追加コメントが
  「ACS の `checkDigitsOnlyChar()` は空白を許容しない」とする理由付けが、
  同じコメントが引く `research.md` F3 の引用コードと矛盾していた
  （引用コードの通りなら空白を許容することになる）。
  — 対応: `Field5250.class` を再デコンパイルして確認したところ、実際の
  コードは NUL文字判定であり空白ではなかった（`research.md`（旧版）F3への
  当初の書き写しが誤りだった、`decisions.md` D4）。`field-validate.ts`・
  `research.md` F3 を訂正した（`aidev taskcheck report T1 --findings 2`）。
- [should][conv:comment-provenance!] T1: 追加コメントの「decisions.md 参照」が
  具体的な D 番号を伴わず、実際に `decisions.md`（D1〜D3）を確認しても
  該当する記述が無かった——出所を `research.md` F2 のみに訂正した。
- [must][conv:comment-provenance!] T3: `field-validate.test.ts` の追加コメント
  でも同じ矛盾（T1 と同一の問題）が指摘された——T1 と同じ訂正を適用した
  （`aidev taskcheck report T3 --findings 2`）。
- [should][conv:comment-provenance!] T3: 同様に「decisions.md 参照」の出所が
  実体を伴わなかった——訂正した。

**この2件のタスク点検（T1・T3）が独立に同じ矛盾を指摘したことで、
`research.md` F3 のコード抜粋自体に書き写し誤りがあることが判明した
（`decisions.md` D4）。** 再デコンパイルで確認したところ、正しい内容は
「NUL文字判定であり空白ではない」で、当初の結論（`SHIFT_DIGITS_ONLY` は
一致する・変更しない）自体は変わらなかった。

**副次的な発見**: `research.md` を Write ツールで書いた際、この誤記部分の
NUL文字表記が**エスケープされず実際の制御バイトとしてファイルに埋め込まれて
しまっていた**——`grep`・`Read` ツール表示・タスク点検の2エージェントの
いずれもがこれを「空白」と読み違えた（NUL は多くのテキスト表示で空白と
区別できない）。`decisions.md` D4 に記録し、`research.md`・`decisions.md`
双方から不可視な制御バイトを除去した（可読なテキスト表記 `NUL(0x00)` に
置き換え）。今後の教訓として D4 に残した。

## レビュー指摘（ラウンド1）

- [should] `test-result.md`「実行したもの」の「`@ts5250/tn5250`: 586 passed
  （`field-validate.test.ts` へ1テスト追加した分を反映）」が事実と異なる——
  実際は既存テスト1件を新しい期待値に**置き換えた**だけで、テスト件数の
  増減は無い（`git stash` で本 work 適用前も同じ586件だったことを確認済み）
  — 対応: `test-result.md` の記述を「置き換えたのみで増減無し」に訂正した。
- [should] `field-validate.ts` の `numericOnly` ブロックのコメントが、
  `decisions.md` D4 に既に記録済みの経緯（`research.md` F3 の書き写し誤りと
  その訂正）をコード側にほぼ全文再掲しており、`AGENTS.md` の二層構成
  （コード側は要点＋参照、経緯は decisions.md）に反していた
  — 対応: コメントを要点のみに圧縮し、`decisions.md` D4 への参照に置き換えた。

指摘は上記2件のみ（must=0, should=2, nit=0）。両方ともその場で対応済み。
