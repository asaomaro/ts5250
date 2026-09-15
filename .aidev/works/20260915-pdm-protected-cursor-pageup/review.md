# レビュー: SEU でカーソルを保護欄に置いた状態で PageUp/PageDown すると、
カーソルがヘッダーの入力欄へ強制移動してしまう不具合の修正

## タスク点検ログ

- [should][conv:comment-provenance!] T1: `sendAid()` 内、`lastSentAid` 更新直前のコメント
  「実機トレースでは未観測で、この work のスコープでは対応しない」の出所が
  `decisions.md 参照` と書かれているが、`decisions.md` にはこの記述が無い（grep で確認、0件）。
  同一の文言は `design.md`「エラー処理 / 異常系」節にあるため、出所をそちらへ訂正した
  — 対応: `packages/tn5250/src/session/session.ts:384` の引用先を
  `decisions.md` → `design.md「エラー処理 / 異常系」` に修正。
- T1: 上記以外の観点（`AidKey | undefined` の型・更新タイミング・Attn/SysReq 除外・周辺コードとの
  一貫性）は問題なし（`aidev taskcheck report T1 --findings 1`）。
- T2: 指摘なし（`aidev taskcheck report T2 --findings 0`）。両分岐への `isPageKey` 適用、
  `isPageKey` の定義位置、Enter/F1 等での非影響、コメントとコードの整合、既存テストとの
  非衝突を確認済み。
- T3: 指摘なし（`aidev taskcheck report T3 --findings 0`）。新規回帰テストのWTD構築・
  discrimination（`git stash` による再現）・既存テストとの一貫性を確認済み。全6テストgreen。
- cross（T1+T2+T3 横断）: 指摘なし（`aidev taskcheck report cross --findings 0`）。T1 の契約
  （`AidKey | undefined`、Attn/SysReq 除外、更新タイミング）と T2 の `isPageKey` 消費側の前提が
  一致していること、T3 が `ReplayTransport` 経由で `sendAid()` → `lastSentAid` 更新 →
  `handleRecord()` → `isPageKey` 判定を実際にエンドツーエンドで通していること、既存2シナリオ
  （F1ヘルプ・27x132切替＝`cursor-default.test.ts`、Enter確定後の保護化＝
  `cursor-stale-on-protected.test.ts` 既存describe）および `sendaid-cursor-sync.test.ts` が
  影響を受けないこと、design.md/decisions.md（D2-D4）と実装・テストの整合を確認済み。

**（以下、D5 の再設計——`isPageKey` を `cursorBeforeWasEnterable` へ置き換え——に伴う
タスク点検。下の「PR レビュー（人間）」節参照）**

- T6: 指摘なし（`aidev taskcheck report T6 --findings 0`）。`isEnterableAt`（buffer.ts）の
  実装、`cursorBeforeWasEnterable` の計算タイミング（`applyDataStream` 呼び出し前）、
  `PR#387` 分岐への組み込み、`!cursorSet` 分岐が無条件へ戻っていること、`lastSentAid`
  関連コードが完全に削除されていることを確認済み。
- [should][conv:comment-provenance] T7: 新規テスト（「送信前に入力可能だった欄が保護化
  された場合は、PageDown でも寄せる」）が `secondScreen()` を `ic` 無しで呼んでおり、
  実際に発火するのは `!result.cursorSet` 分岐（元々無条件）であって、検証したいはずの
  `PR#387` 分岐の `cursorBeforeWasEnterable` ではなかった。テストとしては
  discrimination（AIDキー種別だけで判定する旧実装なら失敗する）が成立していたため
  green だったが、検証対象を取り違えていた。また、その直前のコメント「下の2つ目の
  テストで確認」も、テストが3つに増えたのに更新されておらず参照がずれていた
  — 根拠: `packages/tn5250/test/cursor-stale-on-protected.test.ts`
  （該当テストは178〜180行目、参照コメントは129行目）
  — 対応: `secondScreen({ row: 3, col: 12 })`（ホストが同じ・もう保護化された位置へ
  IC を明示的に指し直す）に修正し、`PR#387` 分岐を直接発火させる形にした。
  コメントの参照も「3つ目（最後）」に訂正した（`aidev taskcheck report T7 --findings 1`）。
- cross（T6+T7 横断、最終ラウンド）: [should][conv:-] 本節（タスク点検ログ）に T6・T7 の
  記録が付け忘れられていた（review.md の更新だけが design.md/decisions.md/research.md/
  tasks.md の更新から取り残されていた）——本節を追記して解消した
  （`aidev taskcheck report cross --findings 1`）。それ以外の観点（`lastSentAid`/
  `isPageKey` の完全撤去、`isEnterableAt` の呼び出しタイミングの一貫性、1つ目の
  describe ブロックが T6 後も壊れていないこと、design.md との実装一致）はすべて
  問題なし。

## レビュー指摘（ラウンド1）

- [should] AC1 は `test-result.md` 上「pass」だが、根拠が合成 WTD によるユニットテストのみで、
  修正後のビルドに対する実機での最終確認が未実施のまま「未検証の穴」に留められていた。
  `.aidev/works/20260914-seu-page-cursor-hold` で実機の事後確認を利用者任せにした結果、
  別の未検知シナリオが後から報告された前例（同work `test-result.md`「T7の位置づけ」）を
  踏まえ、deliver 前に実機で再確認すべき — 根拠: `test-result.md`「受け入れ基準ごとの判定」
  AC1節・「未検証の穴」節、`requirements.md` AC1
  — 対応: `scripts/diag-seu-protected-cursor-pageup.mjs` を修正後のビルドに対して実機
  （SR-OSAKA/ASAOLIB）で再実行し、利用者の再現手順（10桁10行目・PageUp/PageDown）で
  症状が解消したことを直接確認した（`research.md` F6）。`test-result.md`・「未検証の穴」を
  更新し、この項目を解消済みとして記録した。
- [nit] `design.md`「振る舞いの詳細」の「`buffer.ts` の `resize()` 以外に `cursorAddr` を
  書き換える箇所が無いことも確認済み」という主張が不正確。`restoreScreen()`
  （`buffer.ts:615`、RESTORE SCREEN）も `cursorAddr` を書き換える。SEU の PageUp/PageDown
  シナリオには関与しない（RESTORE SCREEN は窓を閉じるときの命令）ため結論への影響は無いが、
  「確認済み」の主張自体が不正確だった — 根拠: `design.md`「振る舞いの詳細」節、
  `packages/tn5250/src/screen/buffer.ts:615`
  — 対応: `design.md` の記述を訂正し、`restoreScreen()` の存在とこの work への非該当性を
  明記した。

指摘は上記2件のみ（must=0, should=1, nit=1）。両方ともその場で対応済み。

## PR レビュー（人間）

PR #399（deliver 済み、未マージ）に対する利用者からの指摘。

- [must][conv:-] 「ホストが位置を送ってくるなら pagedown,pageup などは関係なく、ホストに
  ただ従えば良いだけなのでは？ acsのjarにそのようなキー判定をして特殊対応があったので
  しょうか？」 / 対応: 実機（このプロジェクト自身のクライアント）とデコンパイル済み
  ACS コアの両方で検証した結果、指摘は部分的に正しかった——(1) ACS のコアに AID
  キー種別による分岐は無い（既に `.aidev/works/20260914-seu-page-cursor-hold`
  decisions.md D6 で確認済み。これはデコンパイル済みソースコードの読解によるもの）。
  (2)「ホストに常に従う」も言い過ぎ——ただし「`PR#387` の元シナリオで ACS 自身が
  先頭入力欄へ寄せる」という行動そのものは、今回 ACS を実際に動かして再確認した
  ものではなく、`PR#387`（コミット `c82e2b34`）の commit message にある利用者の
  過去の観測を前提として引き継いでいる（この開発環境には ACS 実機が無く実機同時
  比較ができないため。`research.md` F7「出所の注記」参照）。この行動を所与として、
  それを再現するための判定条件が AID キー種別ではなく「送信前は入力可能だったか」
  （`cursorBeforeWasEnterable`）だったと実機（このプロジェクトのクライアントの
  フィールド構造の計測）で判明した。`isPageKey`（AID キー種別）は、たまたま検証した
  2ケースの相関を拾っていただけで、真の判別軸ではなかった。`lastSentAid`/`isPageKey`
  を撤去し `cursorBeforeWasEnterable` へ全面置き換えた（T6・T7、`decisions.md` D5、
  `research.md` F7）。src: ユーザーの発言（本セッション）。

## レビュー指摘（ラウンド2、D5 再設計後）

- [must] `test-result.md`「受け入れ基準ごとの判定」AC1節が、`research.md` F6・F7 を
  根拠に「`cursorBeforeWasEnterable` 実装後のコードで実機再確認済み」と主張していたが、
  F6 は D5 以前（`isPageKey` 版）に対する実機確認であり、F7 はフィールド構造の
  直接計測（カーソル位置の実機確認ではない）で、どちらも最終実装（
  `cursorBeforeWasEnterable`）に対する実機でのカーソル位置確認を裏付けていなかった。
  `diag-cursor-after-expand.mjs` の実行自体は本セッション内で実際に行っていたが、
  その結果を `research.md` に記録し忘れていた — 根拠: `test-result.md`「受け入れ基準
  ごとの判定」AC1節、`research.md` F6冒頭（"isPageKey 除外を実装した修正後のビルド"）
  — 対応: `research.md` に F8（`cursorBeforeWasEnterable` 実装後のコードでの
  `diag-seu-protected-cursor-pageup.mjs`・`diag-cursor-after-expand.mjs` 両方の
  実機再実行結果）を追記し、`test-result.md` AC1 の引用を F6・F7 → F8 に訂正した。

## PR レビュー（人間・追加）

- [must][conv:-] 「acsの実機確認済とはこちらの報告がソースですか？」 / 対応:
  正しい指摘。「CURSORCL3 のシナリオで ACS 自身が下の入力欄へカーソルを入れる」
  「SEU で ACS はカーソル位置を変えない」という**ACSの行動そのもの**は、この work
  （および前の 20260914 work）で実際に ACS を動かして観測したものではなく、
  `PR#387`（コミット `c82e2b34`）の commit message・`requirements.md`「背景」に
  ある利用者自身の過去の報告・観測が一次情報源だった。この開発環境には ACS 実機が
  無く実機同時比較ができないこと自体は `.aidev/works/20260914-seu-page-cursor-hold`
  decisions.md D6 に既に明記されていたが、その後の記述（`research.md`「実機で
  ACSも寄せる/変えない」等）がこの区別を曖昧にしていた。今回の work で実際に
  実機確認したのは (a) このプロジェクト自身のクライアントのフィールド構造・
  カーソル位置、(b) ACS のデコンパイル済みコアにキー種別による分岐が無いこと、の
  2点のみ。`research.md` F7「出所の注記」・`decisions.md` D5・`review.md`
  （上の「PR レビュー（人間）」節）の該当箇所を訂正し、出所を明示した。
  src: ユーザーの発言（本セッション）。
