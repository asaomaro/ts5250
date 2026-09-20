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
- [ ] 検証エラーの文言がブラウザへ返る経路を塞ぐ（優先度 高）。packages/server/src/ws-handler.ts の sendError(code, err.message, fatal) が例外の message をそのままクライアントへ返すが、validateFieldContent は文言に JSON.stringify(value) で**打鍵した値**を埋める（packages/tn5250/src/screen/field-validate.ts）。マクロの secretRef を型の合わない欄（numeric-only / alphabetic-only / DBCS-only）へ再生すると、**復号済みの秘密が平文でクライアントへ返る**。AGENTS.md「API/ブラウザには平文も暗号文も返さない」に反する。20260920-restore-screen-parity の review ラウンド 3 で発見（同 work はフラグキーの経路を catch で塞いだが、通常キーの write() はこの経路のまま）。手当ての案: 検証エラーは code と欄の位置だけを返し、値を含む文言はサーバー側にも出さない（同 work で足した errShape と同じ扱い）。ログ側は packages/server/test/err-shape.test.ts が固定済みなので、ブラウザ側も同じ形でテストを置く（出典: .aidev/works/20260920-restore-screen-parity/review.md）
