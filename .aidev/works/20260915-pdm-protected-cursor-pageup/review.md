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
