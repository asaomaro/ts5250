# 要件: `PR#387`（保護欄でEnter確定後にカーソルを先頭入力欄へ寄せる）の
ACS前提が未検証だったことへの対応

> **訂正（2026-09-17）**: 本文中の「この開発環境には ACS が無い」「実機 ACS が無いため」は誤り。ACS の jar と、それを使う 5250-operator MCP・中継タップで実測比較できる（`decisions.md` D2 の訂正を参照）。記述は当時の判断の記録として残す。

## 背景 / 課題

`.aidev/works/20260915-pdm-protected-cursor-pageup`（PR #399、未マージ）の作業中、
利用者から「CURSORCL3でACS自身が下の入力欄へカーソルを入れる、というのはこちらの
報告だったか？そうであれば誤報告かもしれない」という指摘があった。

調査の結果、次の事実が判明した:

1. **`PR#387`（コミット `c82e2b34`、既に main にマージ済み・現在も本番で有効）の
   本文・commit message のどちらにも、実際に ACS ソフトウェアを動かして
   CURSORCL3 シナリオと比較検証した記録が無い。** 「検証資材」として挙げられている
   4つのスクリプト（`build-cursortst.mjs`, `diag-cursor-after-expand.mjs`,
   `diag-ic-on-protected.mjs`, `verify-browser-focus-after-expand.mjs`）は、
   いずれもこのプロジェクト自身のクライアント（`Session5250` 核、または
   web-ui のブラウザ DOM フォーカス）を実機ホストに対して計測するだけで、
   実際の ACS を対象にしたものは一つも無い。
2. **PR #387 本文の末尾には未チェックのチェックボックスが残っている**:
   `- [ ] 報告された実際の画面で、Enter 後に下の入力欄へ入ること`
   ——利用者から実際に報告された本物の画面（合成テスト画面 `CURSORTST` ではなく）
   での確認すら、当時完了しないままマージされていた。
3. **ACS のデコンパイル済みコア（`DS5250.preprocessWCC2()`）の全文を読んだ結果
   （`.aidev/works/20260915-pdm-protected-cursor-pageup` research.md F9）、
   カーソル位置の決定は `WTD_IC_addr`/`WTD_MC_addr` の有無だけで完結し、
   「動いていない・いま保護化された」を検知して上書きする分岐は一切存在しない**
   （唯一の例外は GUI 選択ウィジェット専用の狭い特殊ケースで、CURSORCL3 のような
   プレーンなテキスト欄には無関係）。

利用者自身も「当時ACSと比較して報告した記憶は不確か」と回答しており、この前提を
無条件の事実として扱い続けることはできない。一方で、この開発環境には ACS 実機が
無く、実機同時比較による直接確認はできない（`.aidev/works/20260914-seu-page-cursor-hold`
decisions.md D6）。

## 目的 / ゴール

`PR#387` の分岐（`cursorAddr===cursorBefore && cursorIsUnenterable() &&
cursorBeforeWasEnterable` 相当）の妥当性を、**確認できる唯一の一次資料
（ACS のデコンパイル済みコア）に基づいて再評価し、コードの挙動をその一次資料と
矛盾しない状態にする**。実機 ACS による直接確認ができない前提を踏まえ、
「確認できていないことは確認できていないと明示したまま、確認できた事実
（ACS コアは常にホストの IC/MC に従う）に沿わせる」という状態を達成する。

紐づく charter ゴール: 該当する `charter.md` は本プロジェクトに無いため省略。

## ユーザーストーリー

- US1: 開発者（このプロジェクトの保守者）として、ACS のデコンパイル済みコアが
  実際にどう動くかに基づいてカーソル判定ロジックを実装したい。なぜなら、
  未検証の前提のまま既成事実化した挙動が本番に混入すると、後から誰も
  それが正しいのか誤りなのか判断できなくなるため。（受け入れ: AC1, AC2）
- US2: このエミュレータの利用者として、ACS を使っていたときと同じ体験
  （ホストが明示的に指定したカーソル位置がそのまま反映される）をこのプロジェクトの
  クライアントでも得たい。なぜなら、ACS からの移行者にとって「見た目の挙動が違う」
  ことがそのまま生産性の低下・誤操作につながるため。（受け入れ: AC1, AC3, AC4）

**AC5（backlog への記録）はどのユーザーストーリーの価値にも直接紐づかない**——
今後の作業者・利用者が同じ未検証の前提を再び既成事実として扱わないための、
プロセス上の記録要件（`aidev-10-requirements`「書き方の指針」の「ストーリーに
紐づかない基準」に該当）。

## スコープ

### 対象

- `packages/tn5250/src/session/session.ts` の `handleRecord()` にある
  `PR#387` 分岐（`cursorBeforeWasEnterable && cursorAddr===cursorBefore &&
  cursorIsUnenterable()` → `cursorToFirstInputField()`）の扱いを、ACS コアの
  確認済み挙動（IC/MC の有無だけで決まる、他の上書きは無い）に合わせて見直す。
- `packages/tn5250/src/screen/buffer.ts` の `isEnterableAt()`（`PR#387` 分岐
  専用に追加したメソッド）が、上記の見直しにより不要になった場合は併せて整理する。
- 既存の回帰テスト（`packages/tn5250/test/cursor-stale-on-protected.test.ts` の
  「カーソルが保護欄に取り残されたら最初の入力欄へ寄せる」describe ブロック）を
  新しい挙動に合わせて書き直す。
- `.aidev/backlog/acs-parity.md` に、今回の発見（`PR#387` の前提が未検証だった
  こと）を記録する。

### 対象外

- 実際の ACS ソフトウェアを起動しての実機同時比較（この開発環境には ACS が無く、
  利用者の協力が必要。`decisions.md` で言及するに留め、別途 backlog へ残す）。
- `PR#387` 以外の、この work の対象外の既存挙動（`!result.cursorSet` 分岐など、
  ACS コアで既に確認済みの挙動）の変更。
- `.aidev/works/20260915-pdm-protected-cursor-pageup`（PR #399）で対応した
  PageUp/PageDown 固有の症状そのもの——本 work の変更が結果的にその症状の
  修正を包含する可能性はあるが、それを目的にはしない。

## 機能要件

- `handleRecord()` から、ACS コアで確認できない「動いていない・いま保護化された
  →先頭入力欄へ寄せる」という上書き分岐を除去し、ACS コアの確認済み挙動
  （IC/MC の指定にそのまま従う。IC 無しの場合のみ最初の入力欄）に一致させる。
- 上記変更により CURSORCL3 シナリオ（`PR#387` の元の報告）でカーソルが保護欄
  （Enter 確定後に保護化された欄）に留まる——これは ACS コアが確認上そうする
  以上、退行ではなく ACS 挙動への回帰である、という理由を明記する。
- `.aidev/works/20260915-pdm-protected-cursor-pageup`（PR #399）で追加した
  PageUp/PageDown のシナリオ（もともと保護されていた欄）にも回帰が無いこと
  （この変更後は、そもそも上書き分岐自体が無くなるため、両シナリオとも
  ホストの指定にそのまま従う形で解消される）。

## 非機能要件 / 制約

- **推測のみでの修正をしない**: 「ACS が実際にどう動くか」を確認する唯一の
  手段はデコンパイル済みコードの読解であり（実機 ACS が無いため）、その内容
  （`.aidev/works/20260915-pdm-protected-cursor-pageup` research.md F9）を
  設計の根拠にする。
- **確認できていないことを確認済みと書かない**: 「ACS が実際にこのシナリオで
  どう見えるか」は今回も確認できない。requirements/design/decisions のどこにも
  「確認した」と書かず、「コアのコードから推測される」「実機同時比較は未実施」と
  明記する。
- 既存の関連テスト（`cursor-default.test.ts`＝F1ヘルプ・27x132切替、
  `screen-grid-cursor-restore.test.ts`＝SEU走査検索）に回帰が無いこと。

## 完了条件 (受け入れ基準)

- [ ] AC1: `PR#387` 分岐の妥当性が、ACS のデコンパイル済みコア（`research.md` F9）
      という一次資料に基づいて再評価され、コードがその資料と矛盾しない状態に
      なっている。**この見直しにより `isEnterableAt()`（`buffer.ts`）が不要になった
      場合は削除する（死んだコードを残さない）**——不要にならなかった場合はその
      理由を `decisions.md` に残す。
- [ ] AC2: 変更の理由・実機同時比較ができないという制約・当初の PR#387 の
      前提が未検証だったという発見の経緯が、`decisions.md` に記録されている。
- [ ] AC3: 既存の回帰テスト（`cursor-default.test.ts`、
      `screen-grid-cursor-restore.test.ts`、および
      `cursor-stale-on-protected.test.ts` の新設シナリオ側＝PageUp/PageDown）に
      回帰が無いことを確認する。
- [ ] AC4: `cursor-stale-on-protected.test.ts` の「カーソルが保護欄に取り残された
      ら最初の入力欄へ寄せる」describe ブロックが、新しい挙動（ホストの指定に
      そのまま従う）を正しく検証する形に書き直されている。
- [ ] AC5: `.aidev/backlog/acs-parity.md` に、今回の発見と、実機 ACS による
      再確認が今後の課題として残っていることが記録されている。

## 未確定事項 / 確認したいこと

- 実際の ACS が CURSORCL3 のシナリオで本当にどう動くかは、この work のスコープ
  では確認できない（実機 ACS が無いため）。将来 ACS 実機（または `tap-proxy.mjs`
  を使った利用者協力での実機同時比較）が利用可能になったときに再検証する
  余地を残す。
