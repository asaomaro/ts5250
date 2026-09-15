# 仕様: SEU でカーソルを保護欄に置いた状態で PageUp/PageDown すると、
カーソルがヘッダーの入力欄へ強制移動してしまう不具合の修正

## 概要

**達成したい状態**: SEU で保護欄にカーソルを置いたまま PageUp/PageDown しても、
カーソル位置が変わらない（ホストが明示的に IC/MC を送ってくれば従うが、送ってこなければ
送信前の位置をそのまま維持し、先頭入力欄へは寄せない）。

`research.md` F2〜F5 で確認した通り、原因は `session.ts` の `PR#387` 分岐
（`cursorAddr === cursorBefore && cursorIsUnenterable()` → `cursorToFirstInputField()`）
だった。PageUp/PageDown 後、カーソルがあった論理行が新しいページにもう表示されない
場合、ホストは IC/MC を省略せず、**送信前と同じ物理位置（保護欄）を指す IC を
明示的に送ってくる**——これが `PR#387` 分岐の「動いていない・保護欄」という
発火条件にそのまま一致してしまう（`decisions.md` D4）。

**（D5 で判定条件を訂正）** 当初は「直前に送信した AID キーが PageUp/PageDown か」
（`isPageKey`）で判定していたが、deliver 後の利用者指摘（「ホストが位置を送ってくるなら
キー種別に関係なくホストに従えば良いのでは。ACS の jar にキー判定があるのか」）を受けて
実機・ACS デコンパイル済みコアの両方を再検証したところ（`research.md` F7、`decisions.md`
D5）、**真の判別軸は AID キー種別ではなく「このレコードを当てる前、その桁は入力可能
だったか」（`cursorBeforeWasEnterable`）だった**。ACS のコアにキー種別による分岐は
無く（`.aidev/works/20260914-seu-page-cursor-hold` decisions.md D6）、実機で両シナリオの
「送信前の状態」を直接比較すると次のように分かれる:

- CURSORCL3（Enter、`PR#387` 元シナリオ）: 送信前は入力可能な欄 → このレコードで保護化
  される（**遷移あり**）→ 寄せる。
- SEU PageUp/PageDown（今回のバグ）: 送信前から保護されたままの欄 → 変化なし
  （**遷移なし**）→ 寄せない。

`isPageKey` は、たまたま検証した2ケースの相関を拾っていただけで、真の原因ではなかった
（`decisions.md` D5）。

## 設計方針

代替案として「`PR#387` 分岐・`!cursorSet` 分岐を撤去し、ACS 同様つねにカーソルを
動かさない」も検討したが、この2分岐はそれぞれ別の実機確認済みシナリオ（`PR#387`＝
Enter で確定後の保護化、`!cursorSet`＝F1ヘルプ・27x132セッション切替、導入コミット
`7af76ae5`）のために存在し、それらのシナリオでは引き続き「先頭入力欄へ寄せる」動作が
必要（利用者が別途確認済み）。そのため、**分岐そのものは残し、`PR#387` 分岐の条件を
より正確にする**方針を採る（`research.md`「design への申し送り」）。

`.aidev/works/20260914-seu-page-cursor-hold` で撤去した Rule1/Rule2 との違いを明確にする:
Rule1/Rule2 は `cursorSet=true` のケースで、境界ページにおいてホストの IC より送信前の
カーソル位置を優先する、**複数ページにまたがる画面内容比較**（`cellsSignature`）を伴う
複雑な仕組みだった（ACS のコアに相当するロジックが見当たらず撤去）。今回の
`cursorBeforeWasEnterable` は**このレコード1件だけで完結する**（このレコードを当てる
直前の状態と、当てた直後の状態を比べるだけ）——ページをまたいだ比較は一切行わないため、
Rule1/Rule2 が撤去された理由（画面内容比較の複雑さ、ACS コアに専用ロジックが無いこと）
とは無関係であり、撤去した決定と矛盾しない（`decisions.md` D5）。

**`!cursorSet` 分岐は無条件のまま（元の形）にする**——ACS のデコンパイル済みコアが
「IC 無し→常に最初の入力欄」を無条件に実装している（`.aidev/works/
20260914-seu-page-cursor-hold` decisions.md D6）ため、それに合わせる。AID キー種別に
よる除外（`isPageKey`）は撤去する。

## 対象範囲

- `packages/tn5250/src/screen/buffer.ts`:
  - `isEnterableAt(addr: number): boolean` を新設する（指定アドレスが SF 定義された
    非バイパス欄の中か）。
- `packages/tn5250/src/session/session.ts`:
  - `cursorBefore` を捕捉する時点（`applyDataStream` 呼び出し前）で、
    `cursorBeforeWasEnterable = this.buf.isEnterableAt(cursorBefore)` も併せて計算する。
  - `handleRecord()` の `PR#387` 分岐に `cursorBeforeWasEnterable` の条件を追加する。
  - `!result.cursorSet` の分岐は無条件のまま変更しない（`合成WTD`／`isPageKey` 除外は撤去）。
  - 前バージョンで追加した非公開フィールド `lastSentAid` と、`sendAid()` 内の更新ロジックは
    撤去する（`cursorBeforeWasEnterable` はこのレコード内で完結するローカルな判定のため、
    複数レコードをまたいだ状態追跡は不要）。
- `packages/tn5250/test/cursor-stale-on-protected.test.ts`: 新規回帰テストを
  `cursorBeforeWasEnterable` の実際の形（SEU は送信前からずっと保護、CURSORCL3 は
  送信前は入力可能→保護化）に合わせて書き直す。**AID キー種別では判定していないことを
  直接示すテスト**（送信前に入力可能だった欄が保護化されるシナリオで、PageDown を送っても
  寄せられることを確認）を追加する。
- 対象外（変更しない）: `PR#387` 分岐の「動いていない・保護欄」という既存の条件そのもの
  （引き続き前提として残す）、`!cursorSet` 分岐自体の削除（F1ヘルプ・27x132切替のために
  必要）。

## 依拠する既存の事実

- `PR#387` の分岐が実際の原因であること（`research.md` F2、`session.ts` に分岐ごとの
  直接ログを仕込んだ実機トレースで確認済み）。
- 症状は境界ページに限定されないこと（`research.md` F4・F5、実機トレースの3ケース）。
- **真の判別軸が AID キー種別ではなく `cursorBeforeWasEnterable` であること**
  （`research.md` F7。CURSORCL3・SEU 両シナリオの「送信前のフィールド構造」を実機で
  直接計測して確認済み）。
- ACS のデコンパイル済みコア（`DS5250.preprocessWCC2()`）にキー種別による分岐が無いこと
  （`.aidev/works/20260914-seu-page-cursor-hold` decisions.md D6）。
- `!cursorSet` の分岐は F1ヘルプ・27x132セッション切替のために必要であること
  （導入コミット `7af76ae5`、確認場所: `packages/tn5250/test/cursor-default.test.ts`）。
- `PR#387` の分岐は Enter で確定した際に上の欄が保護化されカーソルが取り残される
  シナリオのために必要であること（コミット `c82e2b34`、確認場所: `packages/tn5250/
  test/cursor-stale-on-protected.test.ts`）。
- SEU 走査検索でカーソルが `SEU==>` へ飛ばない既存の挙動が Enter キーで実行される
  こと（動いているため `PR#387` 分岐は対象外——`cursorBeforeWasEnterable` とも無関係）。
  確認場所: `packages/web-ui/test/screen-grid-cursor-restore.test.ts`。
- `ScreenBuffer` に「指定アドレスが入力可能な欄の中か」を答える汎用メソッドが
  無いこと（既存の `cursorIsUnenterable()` は「現在のカーソル位置」専用で、かつ
  「画面のどこかに入力欄があるか」を前提にする——`PR#387` 分岐の「送信前」判定には
  そのまま使えない。確認場所: `packages/tn5250/src/screen/buffer.ts`）。

## インターフェース / データ構造

新しい公開 API は追加しない。`ScreenBuffer`・`Session5250`（いずれも非公開実装）への
変更のみ。

```ts
// packages/tn5250/src/screen/buffer.ts に新設
/** 指定アドレスが、SF で定義された入力可能（非バイパス）な欄の中か */
isEnterableAt(addr: number): boolean {
  const f = this.fields.find((f) => addr >= f.startAddr && addr < f.startAddr + f.length);
  return f !== undefined && (f.ffw & FFW.BYPASS) === 0;
}
```

```ts
// session.ts の handleRecord() 内、cursorBefore を捕捉する時点
// （applyDataStream より前——後だと新しい画面の欄定義に上書きされる）
const cursorBefore = this.buf.cursorAddr;
const cursorBeforeWasEnterable = this.buf.isEnterableAt(cursorBefore);
```

```ts
// handleRecord() 内、既存の2分岐
if (result.readRequested && !result.cursorSet) {
  // 無条件（ACS コアの確認済み挙動と一致。isPageKey 等の除外は無い）
  this.buf.cursorToFirstInputField();
} else if (
  result.readRequested &&
  cursorBeforeWasEnterable &&
  this.buf.cursorAddr === cursorBefore &&
  this.buf.cursorIsUnenterable()
) {
  this.buf.cursorToFirstInputField();
}
```

## 振る舞いの詳細

- `PR#387` 分岐は、**送信前に入力可能だった欄が、このレコードで保護化され、かつ
  カーソルが1桁も動いていない**ときだけ発火する。SEU PageUp/PageDown のように
  「送信前からずっと保護されていた欄をホストが指し直す」場合は
  `cursorBeforeWasEnterable` が false になるため発火しない——AID キー種別を一切
  見ない。ホストが明示的に IC/MC を送ってくれば、通常の属性書き込み経路でその位置が
  そのまま適用される（`research.md` のケース3で確認済み）。送ってこなければ
  （`cursorSet=false`）、`!cursorSet` 分岐が無条件に発火し先頭入力欄へ寄せる。
- `cursorBeforeWasEnterable` は**このレコード1件だけで完結する**局所的な判定
  ——`cursorBefore` を捕捉した瞬間の（＝このレコードを当てる前の）`ScreenBuffer` の
  欄定義を読むだけで、複数レコード・複数ページにまたがる状態を保持する必要が無い
  （旧 `lastSentAid` はセッション全体で状態を持ち回っていたが、それに伴う残存リスク
  ごと不要になった）。
- Attn/SysReq を挟んでも `cursorBeforeWasEnterable` の計算方法自体は変わらない
  （そのレコードの `cursorBefore` を捕捉した時点の状態を見るだけなので、他の
  レコードの影響を受けない）。

## ドメイン固有の考慮

- 該当なし（SEU 固有の判定は行わず、`cursorBeforeWasEnterable` という構造的な条件
  のみで判定する。`PR#387` と同じ方針）。

## エラー処理 / 異常系

- 該当なし。`cursorBeforeWasEnterable` はこのレコード内だけで完結するローカルな
  判定のため、旧 `lastSentAid`（Attn/SysReq 除外の裏返しの誤判定）のような
  複数レコードにまたがる残存リスクは無い（`decisions.md` D5）。

## 受け入れ基準との対応

- AC1: 実機で、保護欄にカーソルを置いた状態から PageUp/PageDown を行っても、
  カーソル位置がヘッダーの入力欄へ強制移動しないことを、`cursorBeforeWasEnterable`
  による `PR#387` 分岐の判定で満たす。test 工程で合成 WTD による回帰テストを
  追加して固定化する。
- AC2: `PR#387` 分岐の**本来の判定条件**（送信前は入力可能だった欄が保護化される
  シナリオ）は変更しないため、既存テスト `cursor-stale-on-protected.test.ts`
  （「依拠する既存の事実」参照）に回帰は無い見込み。test 工程で実行して確認する。
- AC3: `research.md` に実機トレースの記録（3ケースの比較表、分岐ごとの直接ログに
  よる判定結果、F7 のフィールド構造の直接計測）が残っている。
- AC4: 修正方針は `research.md` F2〜F7（実機トレースへの分岐ごとの直接ログ、
  および利用者指摘を受けた再検証）に基づく。推測に基づく判断は無い（当初の
  `isPageKey` 案が相関にすぎなかったと実機で訂正した経緯も含めて記録済み。
  `decisions.md` D5）。
- AC5: SEU 走査検索は動いているため `PR#387` 分岐の対象外——新しい条件とも無関係。
  既存テスト `screen-grid-cursor-restore.test.ts`（「依拠する既存の事実」参照）で
  確認する。
