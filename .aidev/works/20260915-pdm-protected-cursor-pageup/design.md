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
発火条件にそのまま一致してしまう（`decisions.md` D4。当初 `!result.cursorSet` 分岐
（導入コミット `7af76ae5`）が原因と誤診断していたが、計装の不備によるもので、
D4 で訂正した）。**`!result.cursorSet` 分岐は「動いていない」という同じ前提を
共有するため、対称性のため同じ除外条件を適用する**（実機では発火が確認できなかった
が、ホストが将来 IC/MC を省略する場面でも一貫した挙動にするため）。そのため、
**両方の分岐**に「直前に送信した AID キーが PageUp/PageDown のときは発火しない」
という除外条件を追加する。除外条件の実装には「直前に送信した AID キー」の追跡
（`lastSentAid`）が必要——`.aidev/works/20260914-seu-page-cursor-hold` で一度実装・
撤去した仕組みと同種だが、`decisions.md` D2 の通り**別の目的**で再導入する。

## 設計方針

代替案として「`PR#387` 分岐・`!cursorSet` 分岐を撤去し、ACS 同様つねにカーソルを
動かさない」も検討したが、この2分岐はそれぞれ別の実機確認済みシナリオ（`PR#387`＝
Enter で確定後の保護化、`!cursorSet`＝F1ヘルプ・27x132セッション切替、導入コミット
`7af76ae5`）のために存在し、それらのシナリオでは引き続き「先頭入力欄へ寄せる」動作が
必要（利用者が別途確認済み）。そのため、**分岐そのものは残し、PageUp/PageDown の
ときだけ除外する**方針を採る（`research.md`「design への申し送り」）。

`.aidev/works/20260914-seu-page-cursor-hold` で撤去した Rule1/Rule2 との違いを明確にする:
Rule1/Rule2 は `cursorSet=true` のケースで、境界ページにおいてホストの IC より送信前の
カーソル位置を優先する、画面内容比較を伴う複雑な仕組みだった（ACS のコアに相当する
ロジックが見当たらず撤去）。今回は**既存の2分岐（動いていない・保護欄という条件で
発火する）に AID キー種別による除外を加えるだけ**の、より単純な仕組みであり、
`decisions.md` D2 の通り撤去した決定と矛盾しない。

## 対象範囲

- `packages/tn5250/src/session/session.ts`:
  - `Session5250` に非公開フィールド `lastSentAid?: AidKey` を再追加する。
  - `sendAid()` 内で、レコード送信時に更新する（Attn/SysReq は除外——施錠中でも
    別経路で割り込める「フラグレコード」であり、PageUp/PageDown の応答待ちとは
    独立して送られうるため。「インターフェース / データ構造」参照）。
  - `handleRecord()` の**2つの分岐**（`PR#387` 分岐と `!result.cursorSet` 分岐の
    両方）に、`lastSentAid` が PageUp/PageDown のときは発火しないという条件を追加する
    （「概要」参照——`PR#387` 分岐が実際の原因であり主たる修正対象。`!cursorSet`
    側は対称性のため同じ除外を加える）。
- `packages/tn5250/test/`: 新規回帰テスト（合成 WTD による、保護欄でのカーソル維持、
  PageUp/PageDown 両方向）を追加する。既存の回帰テスト `packages/tn5250/test/
  cursor-stale-on-protected.test.ts`（`PR#387` 本来のシナリオ、Enter で確定後の
  保護化）・`packages/web-ui/test/screen-grid-cursor-restore.test.ts`（SEU 走査検索）を
  実行し、回帰が無いことを確認する。
- 対象外（変更しない）: `PR#387` 分岐の**本来の判定条件**そのもの（Enter 等
  PageUp/PageDown 以外のキーでの挙動は変えない）、`!cursorSet` 分岐自体の削除
  （F1ヘルプ・27x132切替のために必要）。

## 依拠する既存の事実

- `PR#387` の分岐が実際の原因であること（`research.md` F2、`session.ts` に分岐ごとの
  直接ログを仕込んだ実機トレースで確認済み。当初は `!cursorSet` 分岐が原因と誤診断
  していたが、`decisions.md` D4 で訂正した）。`!result.cursorSet` 分岐は、この work の
  実機トレースでは発火が確認できなかったが、両分岐とも「カーソルが動いていない」を
  前提の一部にしており、`PR#387` 側だけを除外条件で塞いでも `!cursorSet` 側が
  独立して発火する可能性は構造的には残る（コードの読解による確認。
  `session.ts:638-659` の2分岐の条件式を参照）——対称性のため両方に除外条件を
  加える。
- 症状は境界ページに限定されないこと（`research.md` F4・F5、実機トレースの3ケース）。
- `!cursorSet` の分岐は F1ヘルプ・27x132セッション切替のために必要であること
  （導入コミット `7af76ae5`、確認場所: `packages/tn5250/test/cursor-default.test.ts`）。
- `PR#387` の分岐は Enter で確定した際に上の欄が保護化されカーソルが取り残される
  シナリオのために必要であること（コミット `c82e2b34`、確認場所: `packages/tn5250/
  test/cursor-stale-on-protected.test.ts`）。
- SEU 走査検索でカーソルが `SEU==>` へ飛ばない既存の挙動が Enter キーで実行される
  こと（`isPageKey` と無関係）。確認場所: `packages/web-ui/test/
  screen-grid-cursor-restore.test.ts`。
- `Session5250` が現在「直前に送信した AID キー」を保持していないこと（`.aidev/works/
  20260914-seu-page-cursor-hold` で `lastSentAid` を撤去済み。確認場所:
  `packages/tn5250/src/session/session.ts` に該当フィールドが無いこと）。

## インターフェース / データ構造

新しい公開 API は追加しない。`Session5250`（非公開）への変更のみ。

```ts
// クラスフィールド追加（private）
private lastSentAid?: AidKey;

// sendAid() 内、レコード構築後・送信前後のどこかで更新
// （Attn/SysReq は施錠中でも別経路で割り込める「フラグレコード」であり、
//   PageUp/PageDown の応答待ちとは独立して送られうるため対象外とする）
if (key !== "Attn" && key !== "SysReq") this.lastSentAid = key;
```

```ts
// handleRecord() 内、既存の2分岐**両方**に isPageKey の条件を追加する
// （「概要」の通り、片方だけ塞ぐと構造的に重なるもう片方が代わりに発火する）
const isPageKey = this.lastSentAid === "PageUp" || this.lastSentAid === "PageDown";
if (result.readRequested && !result.cursorSet && !isPageKey) {
  this.buf.cursorToFirstInputField();
} else if (
  result.readRequested &&
  !isPageKey &&
  this.buf.cursorAddr === cursorBefore &&
  this.buf.cursorIsUnenterable()
) {
  this.buf.cursorToFirstInputField();
}
```

## 振る舞いの詳細

- PageUp/PageDown を送信した直後の応答では、**2つの分岐のどちらも発火しない**
  （`isPageKey` が両方の条件に追加されるため）。ホストが明示的に IC/MC を送って
  くれば、通常の属性書き込み経路でその位置がそのまま適用される（`research.md` の
  ケース3で確認済み）。送ってこなければ（`cursorSet=false`）、`cursorAddr` は
  **変更しない**——`ScreenBuffer` の他のどのメソッドも、通常の WTD 適用（画面
  サイズ変更を伴わない）では `cursorAddr` を書き換えないため（`research.md` の
  実機トレースで、`cursorToFirstInputField()` を呼ばなければ送信前の位置がそのまま
  残ることを確認済み）、送信前の位置（利用者が置いた保護欄の位置）がそのまま維持される。
  **訂正**（review 工程で判明）: `buffer.ts` の `cursorAddr` 書き換え箇所は `resize()` だけ
  ではなく、`restoreScreen()`（RESTORE SCREEN。`buffer.ts:615`）も書き換える。ただし
  RESTORE SCREEN は窓を閉じるときの命令で、SEU の PageUp/PageDown シナリオには関与しない
  （`wtd-applier.ts` の呼び出し元を確認済み）ため、この work の結論には影響しない。
- PageUp/PageDown の**次に** Enter・F1 等（Attn/SysReq を除く）の AID キーが送られると、
  `lastSentAid` がその新しいキーで上書きされて `isPageKey` が false に戻るため、
  既存の動作（`!cursorSet` なら先頭入力欄へ／`PR#387` の保護欄退避）はどちらも変わらない。
  **ただし Attn/SysReq は `lastSentAid` を更新しないため、この限りではない**
  （「エラー処理 / 異常系」の既知の残存リスク参照）。
- `lastSentAid` は PageUp/PageDown 以外の AID キー（Attn/SysReq を除く）が送られた
  時点で上書きされるため、「PageUp/PageDown を送った直後の応答」という限定は
  通常のキー操作の範囲では自然に保たれる。

## ドメイン固有の考慮

- 該当なし（SEU 固有の判定は行わず、AID キー種別という構造的な条件のみで判定する。
  `PR#387` と同じ方針）。

## エラー処理 / 異常系

- **既知の残存リスク**: `lastSentAid` が Attn/SysReq を除外する副作用として、
  PageUp/PageDown の応答待ち中に Attn/SysReq を挟むと、`lastSentAid` が
  古い値（"PageUp"/"PageDown"）のまま残り、後で届く**無関係な**レコードに対しても
  `isPageKey` が誤って **true のまま**判定されうる（`.aidev/works/
  20260914-seu-page-cursor-hold` decisions.md D4(2) と同種の、向きも同じリスク——
  D4(2) も「除外の裏返しとして無関係なレコードに `isPageKey` が誤って true 判定
  されうる」というものだった）。誤って true になった場合の影響は「本来なら
  `!cursorSet`/`PR#387` の既定動作で先頭入力欄へ寄せられるべき場面で、寄せられ
  なくなる」——実機トレースでは未観測であり、この work のスコープでは対応しない
  （同じ理由で D4(2) も対応しないと確定済み）。

## 受け入れ基準との対応

- AC1: 実機で、保護欄にカーソルを置いた状態から PageUp/PageDown を行っても、
  カーソル位置がヘッダーの入力欄へ強制移動しないことを、`lastSentAid` による
  `isPageKey` 判定で**2つの分岐両方**を抑止することで満たす。test 工程で
  合成 WTD による回帰テストを追加して固定化する。
- AC2: `PR#387` 分岐の**本来の判定条件**（Enter 等 PageUp/PageDown 以外での挙動）は
  変更しないため（`isPageKey` は Enter では false のまま）、既存テスト
  `cursor-stale-on-protected.test.ts`（「依拠する既存の事実」参照）に回帰は無い見込み。
  test 工程で実行して確認する。
- AC3: `research.md` に実機トレースの記録（3ケースの比較表、分岐ごとの直接ログに
  よる判定結果）が残っている。
- AC4: 修正方針は `research.md` F2〜F5（実機トレースへの分岐ごとの直接ログによる
  確認）に基づく。推測に基づく判断は無い（当初の誤診断を実機で訂正した経緯も
  含めて記録済み。`decisions.md` D4）。
- AC5: SEU 走査検索は Enter で実行される（`isPageKey` は false）ため、新しい条件と
  無関係。既存テスト `screen-grid-cursor-restore.test.ts`（「依拠する既存の事実」参照）
  で確認する。
