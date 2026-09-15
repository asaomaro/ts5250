# 判断記録

## ~~D1: 原因の当初仮説（PR#387 の分岐）を実機トレースで訂正し、
実際の原因（`!cursorSet` の既定分岐）に基づいて設計する~~

**この D1 自体が誤りだったため、D4 で再訂正した。以下は当時の記録として残す
（内容を信用しないこと。正しい結論は D4 を参照）。**

- 背景: `requirements.md`「背景」では、利用者の再現手順（保護欄でカーソルを保持したまま
  PageUp/PageDown）の原因を `PR#387` の分岐（`cursorAddr === cursorBefore &&
  cursorIsUnenterable()`）と推測していた。しかし `research.md`（当時）F2 の通り、
  `ScreenBuffer.cursorToFirstInputField()` を直接計装して実機トレースしたところ、
  実際に発火していたのは**より古い分岐**（`!result.cursorSet` →
  `cursorToFirstInputField()`、導入コミット `7af76ae5`）だった**、と当時は判断した
  （D4 の通り、この判断は計装の不備による誤りだった）**。
- 判断: 設計・実装は `research.md` の実機トレース結果（F2〜F4）に基づき、
  `!result.cursorSet` の分岐に対して行う。`requirements.md`「背景」の当初仮説の
  記述は誤りとして残しつつ（取り消し線は付けず、`research.md` への参照を追記する
  形で訂正する——`aidev-30-tasks`/`aidev-70-deliver` の「事実と食い違うなら取り消し線」
  という規約は backlog 向けだが、同じ精神で requirements.md にも適用する）、
  実際の設計判断は research.md の事実を正とする。
- 理由 / 代替案: 当初仮説が外れたこと自体は、`.aidev/works/20260914-seu-page-cursor-hold`
  の教訓（実機トレースなしで推測すると的外れになりうる）を踏まえて実機トレースを
  行った結果であり、まさにその教訓が活きた形——「実機トレースで裏付けてから設計判断を
  行う」という制約（`requirements.md`「非機能要件」）を徹底したことで、誤った箇所を
  直す事態を防げた**、と当時は考えたが、実際には別の計装の不備が残っていた（D4）**。
- 影響:
  - `requirements.md`「完了条件」の AC2（`PR#387` の回帰確認）は、原因が別分岐だと
    判明した後も**引き続き有効**——修正が隣接する `PR#387` の分岐に影響しないことを
    確認する目的は変わらないため。
  - design は `research.md` の実装アンカー（A1: `session.ts:638-641`）に基づいて行う
    **（D4 の訂正後は A1 の番号・対象箇所が入れ替わっている。最新の research.md を
    参照）**。

## D2: 「直前に送信した AID キー」の追跡（`lastSentAid` 相当）を、
D7（`20260914-seu-page-cursor-hold`）とは別の目的で再導入する

- 背景: `research.md` の修正方針は、`!result.cursorSet` の分岐に「直前に送信した
  AID キーが PageUp/PageDown なら発火しない」という除外条件を追加するというもの。
  これには「直前に送信した AID キー」の追跡が必要で、`.aidev/works/
  20260914-seu-page-cursor-hold` で一度実装した `lastSentAid` と同種の仕組みになる。
  同じ work の decisions.md D7 は、この仕組みを**別の目的**（Rule1/Rule2:
  `cursorSet=true` のケースで、境界ページにおいてホストの IC より送信前のカーソル
  位置を優先する、画面内容比較を伴う複雑な仕組み）のために導入した後、ACS のコアに
  相当するロジックが見当たらなかったとして撤去している。
- 判断: 今回再導入する「直前に送信した AID キー」の追跡は、D7 で撤去した仕組みとは
  **別の目的**（`cursorSet=false` のときの既定動作を AID キー種別で分けるだけの、
  より単純な用途）のため、D7 の決定と矛盾しない。D7 が「ACS のコアに専用ロジックが
  見当たらなかった」としたのは Rule1/Rule2（画面内容比較・境界判定を伴う複雑な
  ヒューリスティック）についてであり、今回の用途（AID キー種別による単純な分岐）
  ではない。
- 理由 / 代替案: 完全に別の実装（例えば `sendAid()` の呼び出し時にコールバック引数で
  渡す等）も検討したが、`lastSentAid` と同じ「フィールドに直前の AID キーを保持する」
  という単純な仕組みが最も既存コードとの一貫性が高く、D4 で指摘された既知の残存
  リスク（Attn/SysReq を挟んだ場合の誤判定）も、今回の用途（`!cursorSet` の除外のみ）
  であれば影響が限定的——design で具体的な実装時に再検討する。

## D3: `isPageKey` 除外条件は `!cursorSet` 分岐だけでなく、隣接する `PR#387` 分岐にも
両方に追加する（片方だけでは効かない）

- 背景: design 工程の独立点検（doccheck）で、D2 で計画した「`!cursorSet` 分岐にだけ
  `isPageKey` 除外を追加する」設計に**実装上の欠陥**があることが判明した。
  `!cursorSet` 分岐と `PR#387` 分岐は、どちらも「カーソルが動いていない」ことを
  条件の一部にしている（前者は `cursorSet` が false＝ホストが位置を指定しなかった
  ため実質的に動いていない、後者は `cursorAddr === cursorBefore` で明示的に
  「動いていない」を条件にする）。そのため、`!cursorSet` 分岐だけを `isPageKey` で
  塞いでも、`else if` として隣接する `PR#387` 分岐が同じ入力（保護欄・動いていない）
  に対して**代わりに**発火し、`cursorToFirstInputField()` が結局呼ばれてしまい、
  修正の意図（カーソル位置を変えない）が達成できない。
- 判断: `isPageKey` 除外条件を、`!cursorSet` 分岐・`PR#387` 分岐の**両方**に追加する。
- 理由 / 代替案: 2分岐を1つに統合する（例えば `(!cursorSet || (cursorAddr===cursorBefore
  && cursorIsUnenterable())) && !isPageKey` という単一条件にまとめる）ことも考えたが、
  可読性が下がり、`PR#387` の元の意図（動いていない＋保護欄という条件で発火する）が
  コード上で見えにくくなる。**2つの独立した分岐として残し、それぞれに同じ除外条件を
  足す**方が、既存コードの構造・コメントとの一貫性が高い。
- 影響: `design.md`「インターフェース / データ構造」のコード例・「振る舞いの詳細」を
  この決定に合わせて修正済み。

## D4: D1 の診断を再訂正する——真の原因は `PR#387` 分岐（当初仮説どおり）であり、
`!cursorSet` 分岐という D1 の結論は計装の不備による誤りだった

- 背景: T2 のコーディング中、`session.ts` に一時的な `console.error` を仕込み、
  `!result.cursorSet` 分岐と `PR#387` 分岐のどちらが実際に発火するかを**分岐ごとに
  直接ログ**して実機トレースし直したところ（`research.md` F2・F3）、症状が起きた
  ケースは**すべて `PR#387` 分岐**が発火していた。`cursorSet` は全ケースで `true`
  （ホストは IC/MC を省略しない）。D1 が「`!cursorSet` 分岐が原因」と結論したのは、
  `ScreenBuffer.cursorToFirstInputField()` という**両方の分岐から共通で呼ばれる
  メソッド**を計装しただけで、呼び出し元（どちらの分岐か）を区別していなかった
  ためだった——`requirements.md` の当初仮説（`PR#387` が原因）の方が正しかった。
- 判断: `research.md`・`decisions.md` D1 を訂正し、`PR#387` 分岐を主たる修正対象と
  記録する。D1 は削除せず取り消し線で残す（誤りの経緯自体が教訓のため）。
  **design.md・tasks.md・実装（T1・T2）は変更しない**——D3 の判断（`isPageKey` 除外を
  `!cursorSet` 分岐・`PR#387` 分岐の**両方**に追加する）は、D1 の誤った前提
  （`!cursorSet` が主因）のもとで導かれたにも関わらず、**結論として両方に追加する
  という実装は、真の原因（`PR#387` 分岐）に対しても、対称性のための予防的措置
  （`!cursorSet` 分岐）に対しても、そのまま正しく機能する**。つまり D1 の診断は
  誤っていたが、D3 のコード変更そのものは（結果的に）正しかった。
- 理由 / 代替案: 実機診断の計装は「そのメソッドが呼ばれたか」ではなく「どの分岐から
  呼ばれたか」まで区別する必要がある、という教訓を今後の work にも活かす
  （`research.md`「実装時の注意」に記録済み）。誤診断に気づけたのは、T2 の
  コーディング段階で改めて実機確認した（`aidev-40-coding` の慣行ではなく、
  この work で「実機トレースの結果を最後まで疑う」姿勢を徹底したことによる）。
- 影響:
  - `research.md` を全面的に書き直し、正しい原因（`PR#387` 分岐）・実装アンカー
    （A1 が `session.ts:642-659` に変更、A2 が `638-641` に変更）を反映した。
  - `packages/tn5250/test/cursor-stale-on-protected.test.ts` の新規テスト
    （PageUp/PageDown 用）を、`cursorSet=false` の合成 WTD から
    **`cursorSet=true` かつホストが同じ保護欄位置を明示的に指し直す**合成 WTD へ
    書き直した（実機で観測した実際の形に合わせるため）。
  - `requirements.md`「背景」の当初仮説（`PR#387` が原因）は、実は**正しかった**
    ため、取り消し線は付けない。

## D5: `isPageKey`（AID キー種別）を撤去し、`cursorBeforeWasEnterable`
（「このレコードを当てる前、その桁は入力可能だったか」）で判定し直す

- 背景: deliver 後（PR #399 未マージ）、利用者から次の指摘があった：「ホストが位置を
  送ってくるなら PageUp/PageDown などは関係なく、ホストにただ従えば良いだけなのでは？
  ACS の jar にそのようなキー判定をして特殊対応があったのか」。この指摘を実機・
  デコンパイル済み ACS コアの両方で検証した。
  1. **ACS のデコンパイル済みコアに AID キー種別による分岐は無い**
     （`.aidev/works/20260914-seu-page-cursor-hold` decisions.md D6 で既に確認済み。
     `DS5250.preprocessWCC2()` は「IC 無し→最初の入力欄」「IC あり→その位置」
     「MC あれば MC 優先」のみで、キー種別は見ていない）。
  2. **代替案「欄の有無で判定する」（SEU の保護位置は SF 定義された欄に属さない、と
     いう当初の理解に基づく仮説）を実機で直接検証したところ、誤りだったと判明した**。
     `packages/tn5250/test/cursor-stale-on-protected.test.ts` を書いた際の想定
     （`research.md`（旧版）F1「どの欄にも属さない」）は、実機の `dump()` が
     **入力可能な欄だけを表示していた**ことによる誤解で、実際には SEU の保護表示領域
     （10/10）も **SF で定義された欄**（`r10c9(71)`、FFW=0x6000＝ID_VALUE|BYPASS）
     に属している。`CURSORCL3`（`PR#387` の元シナリオ）の CODE 欄（FFW=0x6020＝
     ID_VALUE|BYPASS|MONOCASE）も同じく「SF 定義された欄・BYPASS」であり、
     両者はこの軸では区別できない（実機で直接計測して確認。詳細は `research.md` F7）。
     両者の FFW の唯一の差は `MONOCASE` ビット（CURSORCL3 側にのみ立つ）だが、
     これは入力文字の大文字変換に関する属性でカーソル判定とは無関係と判断し、
     判別条件には含めない（元々 CODE 欄が英数字専用フィールドとして定義されていた
     ことの副産物に過ぎないと見られる）。
  3. **真の判別軸は「このレコードを当てる前、その桁は入力可能だったか」
     （`cursorBeforeWasEnterable`）だった**。`CURSORCL3` の CODE 欄は送信前
     （1画面目）は FFW.BYPASS 無し（入力可能）で、Enter の応答（2画面目）で
     BYPASS が付く——**入力可能→保護へ遷移した**。SEU の保護位置は送信前
     （PageUp/PageDown 前の画面）から**ずっと** FFW.BYPASS 付き——遷移が無い。
     実機で両方を計測し、この軸で正しく分かれることを確認した（`research.md` F7）。
     **注記**: ここで「実機で確認した」のはこのプロジェクト自身のクライアントの
     フィールド構造であり、ACS 自身の挙動ではない（ACS は本環境に無く実機同時比較
     不可。`.aidev/works/20260914-seu-page-cursor-hold` decisions.md D6）。
     「CURSORCL3 で ACS が下の欄へ寄せる」「SEU で ACS はカーソルを変えない」という
     行動そのものの一次情報源は、それぞれ `PR#387`（コミット `c82e2b34`）の
     commit message と `requirements.md`「背景」——いずれも利用者の報告・観測に
     基づく（`research.md` F7 の「出所の注記」参照）。
  4. `.aidev/works/20260914-seu-page-cursor-hold` で一度実装した `cursorBeforeWasEnterable`
     （Rule1/Rule2 共通のガードとして）と**同名・同趣旨**だが、あちらは境界ページでの
     画面内容比較（`cellsSignature`）を伴う Rule1/Rule2 全体のガードの一部として使われ、
     Rule1/Rule2 自体が ACS コアに専用ロジックが見当たらず撤去された（同 decisions.md D6/D7）。
     今回は Rule1/Rule2 のような画面内容比較を一切伴わず、**`PR#387` 分岐**
     （このレコード1件だけで完結する、`cursorBefore`／`cursorAddr` の前後比較）**に
     直接組み込むだけ**——撤去された「境界ページの画面内容比較」という複雑さを
     持ち込まない。
- 判断: `lastSentAid`（と `isPageKey`）を完全に撤去し、`PR#387` 分岐の条件を
  `cursorAddr === cursorBefore && cursorBeforeWasEnterable && cursorIsUnenterable()`
  に変更する。`cursorBeforeWasEnterable` は `applyDataStream` を呼ぶ**前**に
  `this.buf.isEnterableAt(cursorBefore)`（新設）で計算する。`!cursorSet` 分岐は
  `isPageKey` 除外を撤去し、元の無条件形へ戻す（ACS コアの確認済み挙動＝
  「IC 無し→常に最初の入力欄」と一致させる。D6 参照）。
- 理由 / 代替案:
  - AID キー種別による判定（旧 D2〜D4）は、たまたま実機で観測した2つのシナリオ
    （Enter→遷移あり、PageUp/PageDown→遷移なし）を正しく分けられていたが、
    **本当の原因（遷移の有無）ではなく相関にすぎなかった**——たとえば PageUp/PageDown
    で本当に「入力可能だった欄がこの応答で保護化される」場面が別のアプリであれば、
    旧実装は誤ってカーソルを保護欄に留めてしまう（`decisions.md`（旧版）が認めていた
    「PageUp/PageDown 以外のロールキーは対象外」という限定も、この意味で本質的な
    限定ではなく、たまたま検証できなかっただけだったと分かる）。
  - `cursorBeforeWasEnterable` はキー種別を一切見ないため、この限定が自然に無くなる
    （どんな AID キーでも、遷移の有無で正しく判定される）。
  - `lastSentAid` の追跡・Attn/SysReq 除外・その裏返しの誤判定という既知の残存リスク
    （旧 design.md「エラー処理 / 異常系」）も、`lastSentAid` 自体を撤去したことで
    まるごと解消する。
- 影響:
  - `packages/tn5250/src/screen/buffer.ts` に `isEnterableAt(addr): boolean` を追加。
  - `packages/tn5250/src/session/session.ts` から `lastSentAid` フィールド・
    `sendAid()` の更新ロジック・`isPageKey` を削除し、`cursorBeforeWasEnterable`
    （`applyDataStream` 呼び出し前に計算）へ置き換えた。
  - `packages/tn5250/test/cursor-stale-on-protected.test.ts` の PageUp/PageDown
    用 describe を書き直した：(a) SEU と同じ「SF定義はあるが送信前からずっと保護」の
    合成 WTD へ修正（旧: 欄に属さない想定は不正確だった）、(b) **AID キー種別では
    判定していないことを直接示す新規テスト**（送信前は入力可能だった欄が保護化される
    シナリオで、PageDown を送っても正しく寄せられることを確認）を追加した。
  - `research.md` に F7（実機での欄構造の直接計測、`cursorBeforeWasEnterable` の
    確認）を追加し、F1 の「どの欄にも属さない」という不正確な記述を訂正した。
