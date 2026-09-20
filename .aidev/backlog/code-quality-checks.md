---
backlog: code-quality-checks
kind: standing
---

# code-quality-checks

<!-- 項目は行頭の `- [ ]` で書く（見出しに書くと aidev status の未着手件数から漏れる） -->
- [ ] JSDoc が宙に浮くのを機械で検知する。既存の JSDoc とその宣言のあいだに新しい JSDoc ブロックを挿し込むと、前者がどの宣言にも結び付かなくなる（TS/エディタは直近のブロックだけを結ぶ）。20260908-session-lifetime-rules-fold で 3 回起きた（T8 / T9 / T12。うち 2 回は独立点検が検出、1 回は自己検出）。ブロックコメントが 2 つ連続する箇所を落とす検査を置けば機械で止まる——packages/web-ui は eslint の対象外なので、走査テスト（packages/*/test/lifetime-flag-containment.test.ts と同じ形）か lint ルールのどちらかで。条項にしないのは、層を下げられるものを規約に置かないため（protocol.md「12.」）（出典: .aidev/works/20260908-session-lifetime-rules-fold/retro.md）
      **判定（`20260919-backlog-acs-triage`）: 対応要・優先度 中** — HEAD（`65f88e64`）で数え直した。
      空行なしで隣り合う JSDoc の組は **55 件**。うち約 **52 件**が実際の事故（元の宣言から外れた・古い JSDoc と重複）。
      内訳は web-ui 20・server 18・hostserver 7・tn5250 4・tn3270 3・scs 3。
      実例: `packages/web-ui/src/session-controller.ts:1128` の `sendKey` の直前に JSDoc が 2 つ続き、`@returns` を持つ方が結び付いていない。
      起票時の「3 回＋1 回」より、在庫が大きい。
      検査は何も無い（`eslint.config.js` に jsdoc 系のプラグインが無く、web-ui は対象外）。
      正規表現の走査（`*/` の直後に空行なしで `/**`。前がファイル先頭でない）で 57 件がヒットし、TS 解析とほぼ一致する。
      既存の走査テストと同じ形で書ける。先に在庫を直すか、ベースラインで許すかの判断が要る。
      新規の発生は 09-08 が最後。review では 09-10 に 1 件（修正済み）。（research F1-9）
- [x] sharedFiles を .aidev/config.yml に宣言する。aidev doctor が「20 コミット中 9 回触られているのに未宣言」として 4 件挙げている（~~packages/web-ui/src/session-controller.ts 9/20、packages/web-ui/test/session-reconnect.test.ts 8/20、packages/server/src/session-manager.ts 6/20、packages/server/test/session-reconnect-grace.test.ts 5/20~~）。~~宣言すると coding のタスク点検の発火条件「共有モジュール・公開 API に触れたタスク」が機械判定になる（aidev-40-coding 手順5）。~~いまは人が思い出す形なので、20260908-session-lifetime-rules-fold では T10 の点検を 1 つ打ち漏らし、cross 点検が拾うまで気づかなかった（出典: .aidev/works/20260908-session-lifetime-rules-fold/retro.md）
      **判定（`20260919-backlog-acs-triage`・PR #406）: 対応不要（差異なし・実害なし: 前提が崩れた）** — 3 つの前提が現状と合わない。
      - 常連の集合: 2026-09-19 の `aidev doctor` が未宣言として挙げるのは、`packages/tn5250/src/screen/buffer.ts` と `session/session.ts` の 2 件（5/20）。起票時の 4 ファイルは直近 20 コミットで 0〜1 回まで落ちた（9 日で集合が入れ替わった）。
      - 機械判定: CLI が sharedFiles を読むのは `worktree` と `doctor` だけで、タスク点検の発火には使われない。
      - 打ち漏らしの原因: T10 の打ち漏らしが起きた work は `mode: autonomous` で、もともと全タスクが点検対象だった。当の retro も、原因をハーネス提案 H2（`[x]` と点検記録の集合差の検査）に帰している。
      doctor の WARN を消すだけなら、宣言か `sharedFilesWindow: 0` の 1〜2 行で済む。（research F1-10）
- [ ] work をまたぐ参照の無修飾を走査で検知する。`decisions.md D<n>` / `前 work の D<n>` / `review ラウンド<n>` が work slug（`\d{8}-[a-z-]+`）で修飾されずにコメントへ書かれたら落ちる検査。20260910-session-reconnect-freeze で comment-provenance 違反が 14 件出て、うち 6 件がこの形（同じファイルに 2 つの work の参照が並んだ瞬間に解決不能になる）。条項は既に在って守られていないので、追記ではなく層を下げる（protocol.md「12.」）。走査は packages/*/test/lifetime-flag-containment.test.ts と同じ形で書ける（出典: .aidev/works/20260910-session-reconnect-freeze/retro.md）
      **判定（`20260919-backlog-acs-triage`）: 対応要・優先度 低（対象の形を直してから）** — 無修飾の在庫は **87 行（40 ファイル）**。
      同じコメントブロックに slug が無いもので、素の `spec D<n>` 等も含めると 261 行。
      複数 work の参照が同居して読み手が解決できない例: `packages/server/src/session-manager.ts:1743`「前 work の D5 / D12」（ファイル内の slug は 8 種）。
      ただし、条項（`3068238f`）ができて以降に入った無修飾は **0 行**。
      起票後に実際に起きたのは別の形だった。
      - 無印の `research.md F<n>`
      - D 番号の無い `decisions.md` 参照（3 works で 4 件）
      さらに、条項 `.aidev/conventions/comment-provenance.md` の規約 3 は `前 work の D10` を正しい例として挙げていて、この起票と矛盾する。
      走査を書く前に、対象の形（相対参照「前 work」「本 work」と `F<n>`）と条項の例を揃える。（research F1-11）
- [x] 「網羅の主張」を書いた箇所を機械で拾えるか検討する。「〜だけ」「のみ」「すべて」「唯一」「揃った」を含むコメントを一覧に出し、review の観点に載せる（落とすのではなく目印にする）。20260910-session-reconnect-freeze で数え漏らしが 3 回（D10 → D11 → D15）、いずれも独立点検が捕まえ、自分では 1 度も気づけなかった（出典: .aidev/works/20260910-session-reconnect-freeze/retro.md）
      **判定（`20260919-backlog-acs-triage`・PR #406）: 対応不要（差異なし・実害なし: 費用に見合わない）** — 一覧にすると件数が多すぎる。
      網羅語（だけ・のみ・すべて・唯一・揃った）を含むコメント行は、`packages/*/src` のコメント 25,897 行のうち **2,186 行（8.4%）**。346 ファイル中 296 ファイルに出る。
      「呼ぶ・読む・経路」と組み合わせても 162 行ある。
      数え漏らしは 1 つの work の 3 件だけで、多くは decisions.md 側の主張だった。コメントの走査では一部しか覆えない。
      09-14 以降の 7 works の review には、該当する指摘が無い。
      残すなら、review 手順での差分 grep（ハーネス側）になる。直近 8 PR の追加コメントでは 0〜34 行。（research F1-12）
- [ ] 出典がリポジトリの外にしかない参照を走査で検知する。20260919-backlog-acs-triage で、台帳に「委譲先 D の L1〜L15」「委譲先 E の A1〜A16」と書いて comment-provenance 違反になった（委譲先の報告はリポジトリに残らないので、後から確かめられない）。research.md に無い数値の引用も同じ形。隣の項目（work をまたぐ参照の無修飾）と同じ走査に乗せられる。条項は既にあって守られていないので、追記ではなく層を下げる（protocol.md「12.」）（出典: .aidev/works/20260919-backlog-acs-triage/retro.md）
- [ ] tn5250 / hostserver のテストも型検査の対象にする。いまは tsconfig が include: ["src"] なのでテストは型検査されず、**関数に引数を足してもテストの呼び出しが古いまま静かに通る**（undefined が渡る）。20260920-restore-screen-parity の review ラウンド 2 で実際に起きた——buildReadScreenExtendedResponse に replyOpcode を足したのに、テスト 7 か所が 2 引数のままで、opcode が undefined のレコードを組みながら 675 件が緑だった。見つけたのは一時の tsconfig でテストを型検査して TS2554（引数不足）を洗ったから。web-ui は既に tsconfig.test.json を持っているので、同じ形を tn5250 / hostserver にも置けばよい（AGENTS.md「ビルド・テスト」にこの非対称の注記はあるが、止める層が無い）。ただし既存テストには snapshot() を引数なしで呼ぶ箇所が多数あるので、先にそれらを直す必要がある（出典: .aidev/works/20260920-restore-screen-parity/review.md）
- [x] 検証エラーの文言がブラウザへ返る経路を塞ぐ（優先度 高）。packages/server/src/ws-handler.ts の sendError(code, err.message, fatal) が例外の message をそのままクライアントへ返すが、validateFieldContent は文言に JSON.stringify(value) で**打鍵した値**を埋める（packages/tn5250/src/screen/field-validate.ts）。マクロの secretRef を型の合わない欄（numeric-only / alphabetic-only / DBCS-only）へ再生すると、**復号済みの秘密が平文でクライアントへ返る**。AGENTS.md「API/ブラウザには平文も暗号文も返さない」に反する。20260920-restore-screen-parity の review ラウンド 3 で発見（同 work はフラグキーの経路を catch で塞いだが、通常キーの write() はこの経路のまま）。手当ての案: 検証エラーは code と欄の位置だけを返し、値を含む文言はサーバー側にも出さない（同 work で足した errShape と同じ扱い）。ログ側は packages/server/test/err-shape.test.ts が固定済みなので、ブラウザ側も同じ形でテストを置く（出典: .aidev/works/20260920-restore-screen-parity/review.md）
      **完了: 20260920-field-error-no-value**。値の埋め込みを `packages/tn5250/src/screen/field-validate.ts`
      の 4 文言から外し、代わりに欄の位置を入れた（`numeric field accepts digits only: "<値>"` →
      `field at (20,7) accepts digits only`）。打鍵値の**長さ**も `packages/tn5250/src/screen/buffer.ts`
      の `FIELD_OVERFLOW` から外した（`value length 18 exceeds field length 10` →
      `field at (5,25) accepts at most 10 characters`）——18 は秘密の文字数だった。
      ws 経由の回帰資産は `packages/server/test/ws-macro-secret.test.ts`（数字専用欄の合成画面で
      **FIELD_TYPE に届く**ことを確かめたうえで平文・一部・長さのいずれも返らないことを見る）、
      位置の配線は `packages/tn5250/test/field-error-position-wiring.test.ts`、
      書式の契約は `packages/web-ui/test/field-at-contract.test.ts`（6 生産者を個数で固定）。
      **変異注入で 14 件すべて「戻すと落ちる」ことを確認済み**（`test-result.md`）。
      クライアント文字列の反射は**欄を書く経路**で 10 か所塞いだ（検証は
      `packages/server/src/ws-field-ref.ts` に集約し 5250・3270 の両方で同じ位置で呼ぶ）。
      **欄の経路の外（`sessionId` / `watchId` / `session` / `system` / `host`）は対象外**として
      このファイルに別項目で起票した（利用者の判断。同 work decisions D11）。
- [ ] クライアント由来の識別子・ホスト名がエラーの文言でブラウザへ返る経路を塞ぐ（AC9 の未達分）。**20260920-field-error-no-value の review ラウンド 4 が ws へ生 JSON を流して 10 通りを実測した**: printer session <sessionId> not found / watch <watchId> not found / invalid session reference "<session|system>" / connect timeout after 15000ms (<ホスト名>:<ポート>)。**うち最後のものは非 As400Error ではなく As400Error("CONNECT_FAILED") で、packages/tn5250/src/transport/tcp.ts:81 が作る**（題を「非 As400Error」と書くと実際に起きている反射を見落とすので注意）。反射そのものは送った本人へ返るだけだが、同 work は macroId について「参照子だけなので安全」を decisions D10 で明示的に覆しており、同じ性質の sessionId / watchId / session / system / host が残っている。表示の乗っ取り（クライアントが web-ui の文言を選ぶ）は web-ui 側で塞いだ（CODES_WITH_FIELD_DETAIL）ので、残るのは反射そのもの。あわせて非 As400Error も確かめる: packages/server/src/ws-handler.ts の catch は err instanceof Error ? err.message : String(err) なので、**As400Error でない例外の文言もそのままクライアントへ返る**（code は INTERNAL_ERROR）。ソケットの ECONNREFUSED <ホスト>:<ポート> や TypeError の文が届きうるため、保存済み設定由来のホスト名・ポートがブラウザへ出る可能性がある。20260920-field-error-no-value の research F2 で発見したが、**コード上は確実に通るものの再現は未実施**なので、まず実際に起こして確かめること（AGENTS.md 判断の原則 2）。同 work で As400Error 側は code に応じた定型文へ寄せたので、非 As400Error も同じ扱いに倒せばよい。あわせて VT core（packages/vt）が onVtInput / onVtResize 経由で投げる例外に打鍵内容が入るかも未確認（同 work decisions D4）（出典: .aidev/works/20260920-field-error-no-value/decisions.md）
- [ ] 3270 で割り当ての無いキーを押したときの案内が見出しだけに退化している。サーバーが作っていた日本語（tn3270-adapt.ts の「このホスト（メインフレーム）の 3270 には割り当てがありません」等）は web-ui が message を出さなくなったため表示されない。AGENTS.md「利用者に見えるメッセージは日本語で…定数は opMessages.ts に 1 か所」に沿うなら、キー不可を専用の code で伝え分けて web-ui 側に文言を置く（ErrorCode の語彙を増やす判断が要る）（出典: .aidev/works/20260920-field-error-no-value/decisions.md）
- [ ] web-ui の test/tab-visibility.test.ts「全タブを畳んでもワークスペースに居られ、バッジは全数を出す」が全件実行のときだけ 5000ms でタイムアウトする（単体実行では 8/8 緑）。20260920-field-error-no-value の変更を全て外した HEAD でも再現するので既存の flake。全件実行は 100 秒・environment 555 秒とセットアップが重く、負荷で境界を越えている疑い。testTimeout を上げるのではなく、この test が何を待っているかを先に特定する（出典: .aidev/works/20260920-field-error-no-value/test-result.md）
- [ ] ws の msg.cursor が実行時に検証されていない。3270 は tn3270/src/session/session.ts の setCursor(undefined, undefined) 経由で cursorPos が NaN になる（5250 は tn5250/src/session/session.ts:380-387 が Number.isInteger と範囲で自前に守っており、その注記自身が「WS の cursor はランタイム検証されていない」と書いている）。20260920-field-error-no-value で fields[].field / fieldId は packages/server/src/ws-field-ref.ts へ寄せたので、兄弟である cursor も同じ境界で検証する。文字列は漏れない（数値に化ける）ので AC9 の範囲外として送った（出典: .aidev/works/20260920-field-error-no-value/review.md）
- [ ] INTERNAL_ERROR が packages/base/src/errors.ts の ErrorCode に無い。ws-handler.ts:310 と mcp-tools.ts:388 が「err instanceof As400Error ? err.code : "INTERNAL_ERROR"」でその場で文字列を作っており、クライアントにはこの code が届く。20260920-field-error-no-value で web-ui の NOTICE_BY_ERROR を Partial<Record<ErrorCode | "INTERNAL_ERROR", string>> に型付けして初めて分かった。語彙に入れるか、別の code に寄せるかを決める（出典: .aidev/works/20260920-field-error-no-value/review.md）
- [ ] ws の gui-select の msg.selected が実行時に検証されておらず、任意の JSON 値が choice.selected（型は boolean）へ入り snapshot() に載って**そのセッションを見ている全員**（読み取り専用の同席者を含む）へ配られる。20260920-field-error-no-value で fieldId / fields は packages/server/src/ws-field-ref.ts へ寄せたので、兄弟である selected も同じ境界で閉じる。**review ラウンド 4 は読んで判断しただけで実行していない**（GUI 選択欄のある画面を合成していない）ので、まず実際に起こして確かめること（AGENTS.md 判断の原則 2）（出典: .aidev/works/20260920-field-error-no-value/review.md）
- [ ] 監査ログの ws_key に無検証・無制限のクライアント文字列が積まれ、GET /api/admin/logs（packages/server/src/admin.ts）からブラウザで読める。packages/server/src/audit.ts の冒頭は「フィールド値は記録しない（座標・種別・結果のみ）」と書いており、msg.key を AidKey の閉じた語彙で検証すれば塞げる。20260920-field-error-no-value decisions D3 はログに key を出す判断自体は明示しているので方針違反ではないが、長さの上限が無い点は別途（出典: .aidev/works/20260920-field-error-no-value/review.md）
- [ ] ws の入力検証を網羅的に走査するテストを置く。20260920-field-error-no-value で fields / fields[].field / fieldId は packages/server/src/ws-field-ref.ts へ寄せたが、**どの ws メッセージのどのフィールドが検証済みか**を保証するものが無い（cursor / selected / key / watchId / sessionId は未検証のまま残った）。WsClientMessage の各型を列挙し、クライアント由来の文字列・数値を受ける項が ws-field-ref の検証を通っているかを走査で見る。handle() が JSON.parse(raw) as WsClientMessage で型を名乗らせているだけなので、型検査では出ない（出典: .aidev/works/20260920-field-error-no-value/retro.md）（出典: .aidev/works/20260920-field-error-no-value/retro.md）
- [ ] 5250 と 3270 で対になる資産を走査で対応付ける。20260920-field-error-no-value は「5250 に足して 3270 を忘れる」を**同じ work で 3 回**踏んだ（キー割り当て・キー名の反射・欄の指定と、その修正の呼ぶ位置）。いずれも WsKeyField のように**両者が共有する型**を入口に持つ関数だったので、共有型から呼び出し元を引いて「片方にしか検証・修正が掛かっていない組み合わせ」を落とすテストが書ける。条項 paired-artifact-sync は !付きが同 work だけで 7 件あり「規約はあるのに守られていない」状態なので、散文ではなく層を下げる打ち手が要る（protocol.md 12. の判別）（出典: .aidev/works/20260920-field-error-no-value/retro.md）
