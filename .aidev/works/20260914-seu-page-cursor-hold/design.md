# 仕様: SEU の PageUp/PageDown で境界ページに到達したときカーソル位置を保持する

## 概要

`Session5250` に「直前に送信した AID キー」を保持する小さな状態を追加し、PageUp/PageDown の
応答を処理する際、**ホストが明示的に送ってきた IC/MC によるカーソル位置指定を、特定の2条件
（後述）のいずれかに該当するときだけクライアント側で無視し、送信前のカーソル位置を保つ**。
既存の `session.ts:613-634`（F1ヘルプ/27x132切替の既定移動、保護欄からの退避）は無改変のまま
保持し、PageUp/PageDown 専用の新しい分岐をそれより手前（優先）に追加する。

## 設計方針

`research.md` の実機トレースで、当初仮説（`session.ts:613-616` の `cursorSet` 無条件
フォールバックが原因）は否定された。実際には**ホストが明示的に**カーソルを移動させている
（cursorSet は常に true）。したがって「IC/MC の欠落を補う」という既存分岐の性質を変えるのではなく、
**「PageUp/PageDown というローカルなページ送り操作の直後に限り、ホストの指示より
直前のカーソル位置を優先する」という新しい、独立した振る舞いを追加する**方針を採る。

代替案として「`session.ts:613-616` の条件式を変更する」も検討したが、`research.md` の F2 が
示す通りこの分岐は今回のどの再現ケースでも発火しておらず、ここを触っても症状は直らない
（既存分岐は F1ヘルプ/27x132切替という別の実機確認済みシナリオのために存在し続ける必要があるため、
今回の目的のために書き換えるのは筋が違う）。

### 「ホストの指示を無視する」2条件

`research.md` の F4 で観測した2種類の「望ましくない移動」を、それぞれ次の条件で捉える。

| 観測した遷移 | 条件名 | 判定 |
|---|---|---|
| 真の境界（それ以上ページが無く、画面が完全に変化しない） | **Rule 2（画面無変化）** | PageUp/PageDown 送信直前の画面内容と、応答適用後の画面内容が完全に一致する |
| 境界の1つ手前（本文行の入力欄が画面から消えるが、画面自体は変化する） | **Rule 1（着地先が入力不可）** | 応答適用後のカーソルが「送信前と異なるアドレスへ移動」し、かつ**移動先が入力不可**（保護欄内、またはどの欄にも属さない） |

**Rule 1 は「送信前と異なるアドレスへ移動」した場合に限定する**（`cursorAddr !== cursorBefore`）。
これを付けない場合、「動いておらず、かつ入力不可」というケース（`session.ts:617-634` の
保護欄退避＝`PR#387`、AC6 が回帰確認の対象）にも新ルールが重なって発火し、
**新ルールが先に評価されるため PR#387 の退避（先頭入力欄へ寄せる）が実行されなくなる**
（新ルールの動作は「直前位置を保つ」＝何もしないのと同義になり、退避が起きない）。
`cursorAddr !== cursorBefore` を条件に含めることで、この重なりを構造的に避ける
（`research.md` にはこの重なりの検証結果は無いため、設計時点の論理的な帰結として明記する。
coding のタスク点検・test で実際に確認する）。

**ホストからの読み取り要求（`result.readRequested`）があり、かつ直前に送信した AID キーが
PageUp/PageDown であるときに限り**、Rule 1・Rule 2 のいずれか一方でも成立すれば、
`this.buf.cursorAddr` を**ホストの IC/MC が指した位置ではなく、PageUp/PageDown 送信直前の
位置に戻す**。なお Rule 1 は「ホストが IC/MC でカーソル位置を指定した」場合
（`result.cursorSet` が true）だけを対象とする——IC/MC が無い場合の扱いは、
`session.ts:613-616` の既存分岐（無改変）に委ねる。

### この方針のトレードオフ（明示しておく判断）

- ACS が同一データストリームに対して実際にどう振る舞うかは実機同時比較で確認できていない
  （`research.md`「実現性/リスク」）。本設計は、requirements.md に明記された**ユーザーが求める
  見た目の挙動**（PageUp/PageDown でカーソル位置が変わらない）を正として実装する。
  ACS の内部実装を再現することは目的にしない。→ `decisions.md` に記録する。
- 本来は「ホストの明示的な指示に従う」のが 5250 端末エミュレータの原則だが、
  **PageUp/PageDown という限定された AID キーに限り**、この原則から意図的に外れる。
  他の 5250 ホストプログラム（SEU 以外）が PageUp/PageDown 相当のロールキーで
  ページごとに異なるフィールド配置を送るケースでは、この設計が**ホストの意図した
  フォーカス変更を妨げる可能性がある**（`research.md` にも `該当なし` — 未確認。
  実機で他プログラムでの回帰が確認された場合の対応は、`.aidev/backlog` へ追記して
  次回以降の課題とする方針を `decisions.md` に記録する）。

## 対象範囲

- `packages/tn5250/src/session/session.ts`
  - `Session5250` に非公開フィールド `lastSentAid?: AidKey` を追加。
  - `sendAid()` 内で、レコード送信前に `lastSentAid` を更新する。
  - `handleRecord()` のカーソル確定ロジック（既存 `613-634` 相当）の手前に、
    上記2条件を判定する新しい分岐を追加する。
- 新規ヘルパー（`session.ts` 内 private、または `screen/buffer.ts` へ追加。tasks で決定）:
  「画面内容が送信前後で完全に一致するか」を軽量に判定する比較。
- `packages/tn5250/test/`（新規テストファイル、または既存の `cursor-default.test.ts` 系への追加。
  ファイル名は tasks で決定）: AC8 を満たす、PageUp/PageDown の境界挙動を検証する
  `Session5250` レベルの自動テスト。
- 対象外（変更しない）: `packages/tn5250/src/protocol/wtd-applier.ts`（`cursorSet` の生成ロジックは
  そのまま。F2 の通り今回の原因ではない）、`packages/tn5250/src/screen/buffer.ts` の既存メソッド
  シグネチャ（`cursorToFirstInputField` / `cursorIsUnenterable` は変更せずそのまま利用する）。

## 依拠する既存の事実

- `session.ts:613-616` の既存分岐（`!cursorSet` で先頭入力欄へ）—
  今回は無関係と判明（`research.md` F2）が、無改変で維持する。確認場所:
  `packages/tn5250/src/session/session.ts:613-616`。
- `session.ts:617-634`（`PR#387`）の既存分岐（動いておらず入力不可なら先頭入力欄へ）—
  確認場所: `packages/tn5250/src/session/session.ts:617-634`。本設計はこれと重ならないよう
  `cursorAddr !== cursorBefore` を条件に含める（上記「Rule 1」参照）。
- `ScreenBuffer.cursorIsUnenterable()` — 現在のカーソルが保護欄内か、どの欄にも属さないかを
  判定する既存メソッド。確認場所: `packages/tn5250/src/screen/buffer.ts:834-841`
  （`aidev-00-start` 事前調査、`research.md` A2 経由）。そのまま流用する。
- `Session5250.sendAid(key, opts)` は `opts.cursor` で送信レコードのカーソル値のみを
  一時的に上書きでき、`buf.cursorAddr` 自体は変えない。確認場所:
  `packages/tn5250/src/session/session.ts:322-386`、
  `packages/tn5250/src/protocol/read-response.ts:233-241,358-367`（`research.md` F7）。
  本設計の `lastSentAid` は `buf.cursorAddr` と同様に `Session5250` 内部の状態として
  別途保持する（`opts.cursor` の一時上書きとは独立）。
- PageUp/PageDown は AID キーとしてホストへラウンドトリップする（ローカル処理ではない）。
  確認場所: `packages/tn5250/src/session/aid-keys.ts:7-8,17-18`
  （`aidev-00-start` 事前調査、`research.md` 冒頭の経緯）。
  → 「直前に送信した AID キー」は `sendAid()` の呼び出し時点で確実に分かる。
- 実機トレースで cursorSet が全ケースで true だった事実、Rule1/Rule2 に対応する具体的な
  カーソル遷移（8/9→4/9→2/9、先頭境界では8/9のまま）。確認場所: `research.md` F1・F4・F5、
  診断スクリプト `scripts/diag-seu-page-cursor-edit.mjs` / `scripts/diag-seu-topboundary.mjs`
  の実行ログ。

## インターフェース / データ構造

`Session5250`（`packages/tn5250/src/session/session.ts`）への変更のみ。公開 API の追加・変更は無い
（`lastSentAid` は非公開フィールド）。

```ts
// クラスフィールド追加（private）
private lastSentAid?: AidKey;

// sendAid() 内、レコード構築後・送信前のどこかで更新
// （Attn/SysReq はフラグレコードで別経路のため、通常の AID 送信パスでのみ更新すればよい）
this.lastSentAid = key;
```

`AidKey` は既存の型（`aid-keys.ts` からインポート済み）をそのまま使う。新しい型は追加しない。

## 振る舞いの詳細

`handleRecord()` 内、`applyDataStream()` 呼び出し直後、既存のカーソル確定分岐
（613-634 相当）の**手前**に以下を追加する（疑似コード）:

```ts
const cursorBefore = this.buf.cursorAddr; // 既存: 送信前のカーソルアドレス
const screenBefore = /* PageUp/PageDown のときだけ、送信前の画面内容を軽量比較用に保持 */;
const isPageKey = this.lastSentAid === "PageUp" || this.lastSentAid === "PageDown";
// 送信**前**の時点でカーソルが入力可能な欄にあったか（cursorIsUnenterable は
// applyDataStream 適用前＝フィールド更新前の状態を見る）。
const cursorBeforeWasEnterable = isPageKey ? !this.buf.cursorIsUnenterable() : false;

const result = applyDataStream(parsed.data, this.buf, this.codec, this.warn);

const screenUnchanged = isPageKey && screenBefore !== undefined && screenBefore === /* 適用後の画面内容 */;
const movedToDeadZone =
  isPageKey &&
  result.cursorSet &&
  this.buf.cursorAddr !== cursorBefore &&
  this.buf.cursorIsUnenterable();

if (result.readRequested && isPageKey && cursorBeforeWasEnterable && (screenUnchanged || movedToDeadZone)) {
  // PageUp/PageDown が実質何も進めなかった（境界）ときは、ホストの指定より
  // 直前のカーソル位置を優先する。
  this.buf.cursorAddr = cursorBefore;
} else if (result.readRequested && !result.cursorSet) {
  this.buf.cursorToFirstInputField();
} else if (result.readRequested && this.buf.cursorAddr === cursorBefore && this.buf.cursorIsUnenterable()) {
  this.buf.cursorToFirstInputField();
}
```

> **coding 中に判明した追加条件（`cursorBeforeWasEnterable`）**: design 時点の当初案は
> `screenUnchanged`（Rule2）に移動有無の除外を付けておらず、**送信前から既に保護欄／
> 欄外にいた状態で画面完全一致・カーソル不動**というケースで、下の2つ目の分岐
> （保護欄からの退避 `PR#387`）と常に重なりうる欠陥があった（タスク単位の独立点検の
> `must` 指摘で発見。`decisions.md` の記録は無いが、`review.md`「タスク点検ログ」T3 に
> 経緯が残る）。修正として、`screenUnchanged`・`movedToDeadZone` のどちらの経路でも
> 共通して「送信前のカーソル位置がそもそも入力可能だったか」を追加条件にした
> （保つべき「良い」位置が無ければ、この分岐ではなく既存の保護欄退避に判定を譲る）。
> 実装・回帰テストは `packages/tn5250/src/session/session.ts` と
> `packages/tn5250/test/cursor-page-boundary.test.ts`（「AC6 回帰」ケース）を参照。

- `screenBefore` の取得・比較は **`isPageKey` のときだけ**行う（他の全 AID キーでは
  従来通り一切の追加コストを掛けない）。
- 比較の実装（`screenBefore` の型・比較方法）は、既存の `ScreenBuffer` のセル配列を
  軽量な文字列や配列として取り出し、適用前後で等しいかだけを見る形を想定する
  （新しい公開 API は増やさず、`session.ts` 内の private ヘルパー、または
  `ScreenBuffer` に private/internal 相当のヘルパーを1つ追加する程度。
  具体的な関数シグネチャは tasks で決定する——設計判断としては
  「セル内容の完全一致比較」であることだけを固定する）。
- **`lastSentAid` は PageUp/PageDown 以外の AID キーが送られた時点で上書きされる**ため、
  「PageUp を送った直後の応答」という限定は自然に保たれる（例えば PageDown の後に
  何か入力して Enter を押せば、次の応答では `isPageKey` は false に戻る）。

## ドメイン固有の考慮

- SEU 固有の挙動を前提にした画面タイトル文字列などによる判定は**行わない**
  （このリポジトリの既存の類似修正 `PR#387` も AID・カーソル状態という構造的な条件だけで
  判定しており、特定プログラムを名指ししていない。同じ方針に合わせる）。
- 本設計は **PageUp/PageDown という AID キー種別**にのみ作用し、ROLL オーダー
  （`packages/tn5250/src/protocol/wtd-applier.ts` の `COMMAND.ROLL` 処理。ホスト発の画面内容
  シフト）とは無関係（ROLL は WTD 内のオーダーであり、AID キーではない別物。
  `research.md` 冒頭の事前調査で区別済み）。

## エラー処理 / 異常系

- `screenBefore` の取得に失敗する、または比較対象のサイズが食い違う
  （画面サイズが変わった等、通常のPageUp/PageDown では起きないはずのケース）場合は、
  安全側として `screenUnchanged = false` 扱いにする（新ルールを発火させず、既存の
  ホスト指定をそのまま尊重する。誤って「変化なし」と判定して不必要にカーソルを
  固定してしまう方が、逆に「変化あり」を見逃してホストの正しい指定を無視するより
  実害が大きいと判断）。
- `lastSentAid` が未設定（接続直後で一度も `sendAid` を呼んでいない）場合、
  `isPageKey` は false となり、新ルールは一切発火しない（既存動作のまま）。

## 受け入れ基準との対応

- AC1: PageDown を繰り返し最終ページに到達しても、カーソル位置が維持される。
  → Rule 1（境界の1つ手前、着地先が入力不可）と Rule 2（真の境界、画面無変化）の
  組み合わせで、最終ページ到達までの全遷移でカーソルが送信前の位置に固定される。
  入力: `research.md` F4 の実機トレース結果（8/9 → 8/9 が7回、8/9→4/9 の遷移で Rule1、
  4/9→2/9 相当の遷移で Rule2 が救う）。
- AC2: PageUp を繰り返し先頭ページに到達しても、カーソル位置が維持される。
  → 先頭境界は現状でもホストが自然に維持している（`research.md` F5）ため回帰しないが、
  Rule 2（画面無変化）が同じ条件で対称に効くため、他のダミーソース・実データで
  先頭境界に同種の1手前状態（Rule1相当）が存在した場合も同じ仕組みで救われる。
  入力: `research.md` F5。
- AC3: 途中ページへの PageUp/PageDown（境界でない）で、カーソル位置維持の既存の
  正しい挙動に回帰がない。
  → 非境界遷移では `screenUnchanged` も `movedToDeadZone` も成立しない
  （画面は変化し、ホストの IC は入力可能な欄を指す）ため、新ルールは発火せず、
  ホストの IC がそのまま適用される（現状と同じ）。入力: `research.md` F4（#1〜#8）。
- AC4: 境界ページ到達時のホスト応答（IC/MC の有無）を実機トレースで確認し、記録が残っている。
  → `research.md`（本 work の research 工程）で充足済み。
- AC5: F1ヘルプ表示時・27x132セッション切替時のカーソル既定移動に回帰がない。
  → この既存分岐（613-616）はトリガとなる AID キーが F1 等であり `isPageKey` が
  false になるため、新ルールと排他。入力: `research.md`（`cursor-default.test.ts` の
  既存前提）、`aidev-00-start` 事前調査（導入コミット `7af76ae5`）。
- AC6: 保護欄に取り残されたカーソルを先頭入力欄へ寄せる挙動（`PR#387`）に回帰がない。
  → 「振る舞いの詳細」の2点で担保する。(1) Rule1（`movedToDeadZone`）は
  `cursorAddr !== cursorBefore` を条件に含み、`PR#387` が対象とする「動いていない・
  入力不可」ケースとは重ならない。(2) Rule1・Rule2 共通の `cursorBeforeWasEnterable`
  （coding 中に追加。上記「coding 中に判明した追加条件」参照）が、「送信前から既に
  保護欄／欄外にいた」ケースを新ルールの対象から外し、`PR#387` に判定を譲る——
  これが無いと Rule2（`screenUnchanged`）単独でも `PR#387` と重なりうる欠陥があった。
  入力: `packages/tn5250/src/session/session.ts:635-672` のコメント・条件式、
  `packages/tn5250/test/cursor-page-boundary.test.ts`「AC6 回帰」ケース。
- AC7: SEU 走査検索でカーソルが `SEU==>` へ飛ばない既存の挙動に回帰がない。
  → 走査検索は `Enter` で実行される（`research.md` 冒頭、診断スクリプトの `searchTo()`）ため
  `isPageKey` は false。新ルールと無関係。入力: `research.md`、
  `packages/web-ui/test/screen-grid-cursor-restore.test.ts` の既存前提。
- AC8: 境界ページでのカーソル維持を検証する自動テストが追加されている。
  → 実機無しで検証可能な設計にした（`applyDataStream` に手作りの WTD バイト列を渡す
  既存パターン。`cursor-default.test.ts` / `cursor-stale-on-protected.test.ts` と同様、
  「1画面目 WTD（IC あり、本文行にカーソル）→ PageDown 送信 → 2画面目 WTD
  （IC が別の入力不可な位置、または1画面目と同一内容の WTD）」という合成データで
  `Session5250` レベルの統合テストを書ける。tasks でテストケースを具体化する。
  入力: `packages/tn5250/test/cursor-default.test.ts` /
  `packages/tn5250/test/cursor-stale-on-protected.test.ts`（既存の合成 WTD テストパターン）、
  本設計「対象範囲」に追記した新規テストファイル。
