# レビュー記録: ホストのエラーの間の WTD の保留

## タスク点検ログ
- [should][conv:-] T1 session.ts: WEC＋WTD＋READ の 1 レコードで READ ごと溜まり、AID の待ちが時間切れまで解けない / 対応: 保留が始まったら AID の待ちをエラーの画面で解く（テスト）
- [should][conv:-] T1 session.ts: sendAid が流した後の画面から欄を読む・欄を書くのが流す前 / 対応: ws の key・MCP の send_key と手順で、欄を書く前に抜ける
- [should][conv:-] T1 session.ts: Attn・SysReq で抜けないと CANCEL INVITE まで溜まる / 対応: 全てのキーで抜ける（テスト）
- [nit][conv:-] T1 同じレコードの WTD より前の CC2 は ACS では流すまで遅れる / 対応: 変えない（backlog の未確認に残す）
- [nit][conv:-] T1 閉じた後の dismiss で流し直す / 対応: 閉じていれば捨てる
- [nit][conv:-] T1 sendAid の JSDoc の位置 / 対応: 直した
- [should][conv:-] T2 予約中に無視すると、画面の側が隠したまま止まる / 対応: 画面の側が、隠したエラーが残った画面を受けたら送り直す（次の画面で）
- [should][conv:-] T2 HLLAPI の @R（Reset）で抜けない / 対応: 編集キー以外で抜ける
- [should][conv:test-input-shape!] T2 server 側のテストが無い / 対応: 形の誤り・open 前・読み取り専用のテストを足した
- [nit][conv:-] T2 onActivity の JSDoc の位置 / 対応: 直した
- [nit][conv:-] T2 監査に残さない / 対応: 変えない（activity と同じく値を持たない操作——ws-messages の注記どおり）
- [should][conv:paired-artifact-sync] T3 送れなかったときに画面の側だけ隠れる / 対応: 次の画面で送り直す（テスト）
- [should][conv:-] T3 先打ちがエラーの判定より前で、施錠のままだと抜けられない（デッドロック）/ 対応: エラー状態の振り分けを先打ちより前へ（テスト。変異で落ちる）
- [nit][conv:paired-artifact-sync] T3 Attn・SysReq で UI と core が分かれる / 対応: core も抜けるようにして揃えた
- [nit][conv:verify-by-mutation] T3 Reset・施錠中の出口のテスト / 対応: 足した

## ラウンド 1
- [must][conv:-] EmulatorPane.vue: 「ACS も施錠中にエラーを抜けるキーを通す」は原典と合わない（`PS5250.keyDown` は施錠中は Reset・Attn・SysReq などだけ）。ACS が行き詰まらないのは WEC の処理（`DS5250.initKeyboard`）がエラー状態なら施錠を解くため / 対応: 並べ替えを戻し、core で保留が始まったら施錠を解く（ACS と同じ）。テストを直した
- [should][conv:-] session.ts: D4 で返す画面が施錠のまま / 対応: 上と同じ（keyboardLocked=false をテストで固定）
- [should][conv:-] EmulatorPane.vue: 予約が解けたとき画面が届かないので送り直しが起きない / 対応: 予約（reservedBy）の変化でも見る（テスト）
- [should][conv:paired-artifact-sync] mcp-tools.ts の set_fields・HLLAPI の文字が流す前の画面に書く / 対応: set_fields は書く前に抜ける、HLLAPI の文字はエラー中は拒否（ACS はエラー中の文字キーを入れない）
- [nit][conv:-] hllapi.ts の定数の位置 / 対応: JSDoc の前へ
- [nit][conv:-] EmulatorPane.vue の意味の無い分岐 / 対応: 並べ替えを戻したので消えた
- [nit][conv:-] hostHeld に上限が無い / 対応: 500 本で抜けて流す（テスト）
- [nit][conv:comment-provenance] verify スクリプトの research F1 の出所 / 対応: work 名を添えた

## ラウンド 2
- 前ラウンドの 8 件の解消を確認（tn5250 1006・server〔時間切れの流し直しで緑〕・web-ui の関係するファイル）。このラウンドの差分に must/should は無い
