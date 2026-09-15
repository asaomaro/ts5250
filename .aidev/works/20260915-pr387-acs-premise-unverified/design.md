# 仕様: `PR#387` の ACS 前提が未検証だったことへの対応

## 概要

**達成したい状態**: `handleRecord()` のカーソル判定ロジックが、確認できる唯一の
一次資料（ACS のデコンパイル済みコア、`research.md` F3）と矛盾しない状態になって
いる。具体的には、「動いていない・いま保護化された→先頭入力欄へ寄せる」という
`PR#387` 分岐（`cursorBeforeWasEnterable && cursorAddr===cursorBefore &&
cursorIsUnenterable()`）を削除し、ホストの IC/MC 指定にそのまま従う（IC/MC が
無い場合のみ最初の入力欄、という `!cursorSet` 分岐は変更しない）。

`research.md` F1〜F4 の通り、`PR#387` の「ACS は下の入力欄にカーソルを入れる」
という前提は、(1) 実際に ACS を動かして検証された記録が無く、(2) PR 本文の
検証チェックリストに未チェック項目が残ったままマージされ、(3) 利用者自身も
「当時比較した記憶は不確か」と回答しており、(4) ACS のコア
（`DS5250.preprocessWCC2()`）の全文を読んでも、この上書きに相当するロジックは
存在しない。**確認できる事実（ACS コアは常に IC/MC に従う）に矛盾する分岐を、
未検証の前提だけを根拠に残す理由が無い。**

## 設計方針

代替案として「`PR#387` 分岐は残しつつ、条件をさらに絞り込む」（例えば
`.aidev/works/20260915-pdm-protected-cursor-pageup` で行った
`cursorBeforeWasEnterable` の追加のように、発火条件を狭める方向）も検討したが、
**根本の前提（ACS がこの場面で上書きする）自体が確認できない以上、条件をどれだけ
絞り込んでも「存在するかどうか分からない ACS の挙動を模倣する」という構造は
変わらない**。今回は前提そのものを疑っているため、条件の調整ではなく**分岐の
削除**が筋が通っている（`research.md`「design への申し送り」）。

`!result.cursorSet` 分岐は変更しない——`research.md` F3 で確認した通り、
`WTD_IC_addr == -1` → `setDefaultInsertCursor()` という ACS コアの挙動と
直接一致する、数少ない確認済みの事実だからである。

## 対象範囲

- `packages/tn5250/src/session/session.ts`:
  - `handleRecord()` の `PR#387` 分岐（`else if` 節、`research.md` A1）を削除する。
  - `cursorBeforeWasEnterable` の計算箇所（`research.md` A2）を削除する
    （削除後の分岐がこの値を使わなくなるため）。
  - `!result.cursorSet` 分岐はそのまま残す。
- `packages/tn5250/src/screen/buffer.ts`:
  - `isEnterableAt()`（`research.md` A3）を削除する——`PR#387` 分岐でのみ
    使われており、削除後は呼び出し元が無くなる。
  - `cursorIsUnenterable()` も同様に `PR#387` 分岐でのみ使われており（依拠する
    既存の事実を参照）、削除後は呼び出し元が無くなるため併せて削除する。
- `packages/tn5250/test/cursor-stale-on-protected.test.ts`:
  - 1つ目の describe ブロック（「カーソルが保護欄に取り残されたら最初の入力欄へ
    寄せる」、4テスト）を、新しい期待値（寄せない＝ホストの指定にそのまま従う）
    に書き直す。
  - 2つ目の describe ブロック（PageUp/PageDown、`decisions.md` D5 で追加）は、
    `PR#387` 分岐が無くなることで**それ自体が不要になる**——分岐が存在しない
    以上、`cursorBeforeWasEnterable` に基づく discrimination は成立しない
    （常に「寄せない」になるため、テストとしての区別する力が無くなる）。
    このブロックは削除する。
- 対象外（変更しない）: `!result.cursorSet` 分岐、SEU 走査検索
  （`packages/web-ui/test/screen-grid-cursor-restore.test.ts`）・F1ヘルプ・
  27x132切替（`packages/tn5250/test/cursor-default.test.ts`）関連の
  既存挙動、`.aidev/works/20260915-pdm-protected-cursor-pageup`（PR #399）の
  他の成果物（`lastSentAid` 撤去等、既に完了済み）。

## 依拠する既存の事実

- `PR#387` の「ACS は下の入力欄にカーソルを入れる」という前提が未検証であること
  （`research.md` F1・F2・F4）。
- ACS のデコンパイル済みコア（`DS5250.preprocessWCC2()`）に、この上書きに相当する
  ロジックが存在しないこと（`research.md` F3、コード全文を確認済み）。
- `cursorIsUnenterable()`・`isEnterableAt()` が `PR#387` 分岐でのみ使われている
  こと（確認場所: `grep -rn "cursorIsUnenterable\|isEnterableAt"
  packages/tn5250/src` — テストファイルを除き `session.ts` の `PR#387` 分岐と
  `buffer.ts` の定義以外に出現しない）。
- `!result.cursorSet` 分岐が ACS コアの確認済み挙動と一致すること
  （`research.md` F3）。

## インターフェース / データ構造

新しい公開 API は追加しない。既存の非公開実装から削除するのみ。

```ts
// session.ts の handleRecord() 内、削除前:
const cursorBeforeWasEnterable = this.buf.isEnterableAt(cursorBefore); // ← 削除
...
if (result.readRequested && !result.cursorSet) {
  this.buf.cursorToFirstInputField(); // ← 変更しない
} else if (
  result.readRequested &&
  cursorBeforeWasEnterable &&
  this.buf.cursorAddr === cursorBefore &&
  this.buf.cursorIsUnenterable()
) {
  this.buf.cursorToFirstInputField(); // ← このelse if節ごと削除
}
```

```ts
// 削除後:
if (result.readRequested && !result.cursorSet) {
  // IC/MC が無ければカーソルは最初の入力フィールドへ（5250 の既定動作）。
  // 原点に残すと AID レコードで報告するカーソル位置が実機とずれる
  this.buf.cursorToFirstInputField();
}
// PR#387 分岐は削除した（.aidev/works/20260915-pr387-acs-premise-unverified
// decisions.md 参照）。ホストが IC/MC で指定した位置は、それが保護欄であっても
// そのまま尊重する——ACS のデコンパイル済みコアがそうしているため
// （research.md F3）。
```

```ts
// buffer.ts から削除:
isEnterableAt(addr: number): boolean { ... }   // ← 削除
cursorIsUnenterable(): boolean { ... }          // ← 削除
```

## 振る舞いの詳細

- ホストが IC/MC でカーソル位置を明示的に指定した場合、それが保護欄（入力
  できない桁）であっても**そのまま適用する**——分岐が無くなるため、上書きは
  一切発生しない。
- IC/MC が無い場合のみ、従来通り最初の入力欄へ（`!cursorSet` 分岐、変更なし）。
- **副作用として、`.aidev/works/20260915-pdm-protected-cursor-pageup`（PR #399）
  が対応した SEU の PageUp/PageDown の症状も、この変更で解消される**——
  `PR#387` 分岐自体が無くなるため、保護欄を指し直す IC を受けても何も上書き
  しない。PR #399 で追加した `cursorBeforeWasEnterable`／`isEnterableAt` は
  この work で削除するため、2つの work の変更は競合しない（PR #399 の変更は
  「本 work によって不要になった」という形で吸収される）。
- **CURSORCL3 のシナリオ（`PR#387` の元の報告。`research.md` F1・F2 が指す
  実機テスト対象）では、カーソルが保護化された欄に留まり、利用者が Tab を
  押すまで入力できない、という `PR#387` 以前の挙動に戻る。** これは ACS コアの
  確認済み挙動（IC をそのまま尊重する）に
  一致させるための意図的な変更であり、単純な退行ではない——ただし ACS が
  実際にこの場面でどう見えるかは今回も確認できていない（「エラー処理 /
  異常系」参照）。

## ドメイン固有の考慮

- 該当なし。

## エラー処理 / 異常系

- **既知の限界（対応しない、明示するに留める）**: 実機 ACS による直接確認が
  この開発環境では不可能なため、「CURSORCL3 のシナリオで ACS が実際にどちらの
  挙動を示すか」は今回も検証できない。本設計は「確認できる唯一の事実
  （ACS コアは常に IC/MC に従う）に矛盾しない」という基準で判断しており、
  「ACS の実際の見た目の挙動と完全に一致する」という保証はしていない。
  将来、実機 ACS（または利用者協力による `tap-proxy.mjs` を使った実機同時
  比較）が可能になった時点で再検証する（`.aidev/backlog/acs-parity.md` に
  記録する、`decisions.md` 参照）。
- もし将来、実機同時比較で「ACS は実際に CURSORCL3 で下の欄へ寄せる」ことが
  確認された場合は、この work の変更を差し戻し、`PR#387` 相当の分岐を
  正しい条件（何が真の判別軸かを実機で確認した上で）で再実装する必要がある
  ——`decisions.md` にこの可能性を明記する。

## 受け入れ基準との対応

- AC1: `handleRecord()` から `PR#387` 分岐を削除し、`buffer.ts` の
  `isEnterableAt()`（呼び出し元が無くなるため削除）・`cursorIsUnenterable()`
  （同）を整理することで満たす。
- AC2: 発見の経緯は本 design.md「概要」に、実機同時比較ができない制約と将来の
  再検証の余地は「エラー処理 / 異常系」に記録しており、これらに加えて
  `decisions.md` にも記録することで満たす（「設計方針」は代替案の比較検討の
  記録であり、この3項目の記録先ではない）。
- AC3: test 工程で `cursor-default.test.ts`（F1ヘルプ・27x132切替、対象範囲
  「対象外」参照）・`screen-grid-cursor-restore.test.ts`（SEU走査検索、同）を
  実行して回帰が無いことを確認する。加えて、`cursor-stale-on-protected.test.ts`
  の PageUp/PageDown シナリオは「対象範囲」の通りテストコード自体を削除する
  ため実行はできない——代わりに、`PR#387` 分岐の削除によって SEU の
  PageUp/PageDown の症状そのものが解消されることを、実機（`research.md`
  「実装時の注意」参照）で確認する。
- AC4: `cursor-stale-on-protected.test.ts` の1つ目の describe ブロックを、
  「寄せない（ホストの指定にそのまま従う）」という新しい期待値に書き直す
  （「対象範囲」参照）。
- AC5: `.aidev/backlog/acs-parity.md` に、今回の発見（`PR#387` の前提が未検証
  だったこと）と、実機 ACS による再確認が今後の課題として残っていることを
  記録する（deliver 工程で実施）。
