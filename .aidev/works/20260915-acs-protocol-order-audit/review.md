## review ラウンド1（要件適合・価値適合）

別コンテキストによる点検を実施。指摘 0 件（`CHECK: ok`）。AC1〜AC5 いずれも
実装・テストで満たされていること、この work が「利用者が実際に遭遇したか
未確認の潜在的欠陥の予防的修正」という位置づけであることが requirements.md・
research.md・test-result.md・実装コードのコメントの4箇所で一貫して正直に
記述されていることを確認した（過大な効果主張なし）。

## タスク横断点検（cross、coding 手順5.5）

3件の指摘があった。
- (should, [conv:paired-artifact-sync!]) `constants.ts` の `ORDER.UNKNOWN_1C` doc
  コメントを「確認済み」に更新したが、`wtd-applier.test.ts` の対応する既存テストの
  docstring に旧来の「正体未確認・実機表示との突き合わせで確定」という文言が
  そのまま残っており、矛盾していた。テスト側の docstring も「正体は
  `20260915-acs-protocol-order-audit` で確定済み」と更新し、`constants.ts` の
  doc コメントを参照する形にした。
  — 根拠: `packages/tn5250/test/wtd-applier.test.ts`（0x1C の既存テストの docstring）
- (should) `design.md`「設計方針」が「この判断を `decisions.md` に記録する」と
  明言していたのに、`decisions.md` が実際には作られていなかった（design→tasks の
  分解で抜け落ちていた）。`decisions.md` D1 として、`ORDER.UNKNOWN_1C`/
  `UNKNOWN_1E` の実装構造を作り替えない、という設計判断を記録した。
  — 根拠: `.aidev/works/20260915-acs-protocol-order-audit/design.md`「設計方針」
- (should, [conv:paired-artifact-sync]) `AGENTS.md`「残課題」に残る
  「`ORDER.UNKNOWN_1C`（0x1C）の正体が未確認」という項目が、この work で
  確認済みになったにも関わらず未更新だった。`AGENTS.md`「記録の同期（deliver 時）」
  の規約（`- [ ]`→`- [x]`化・取り消し線での事実修正）に従い、**deliver 工程で
  同じ PR に含めて更新する**（coding 工程の対象ではないため、ここでは修正せず
  申し送りとして記録するに留める）。
  — 根拠: `AGENTS.md`「残課題」節の `ORDER.UNKNOWN_1C` 項目、
  「記録の同期（deliver 時）」節

## タスク点検ログ（coding 工程内・「3.3」(b)）

- T1 (should x2, [conv:comment-provenance!] x2): `constants.ts` の `UNKNOWN_1C`/`UNKNOWN_1E`
  doc コメントの引用番号が、実際に裏付ける research.md の節と食い違っていた。
  「独立参照実装（tn5250j）も未実装」は F5 が正しい出典なのに F2/F3 を引用していた、
  「WEA と同様の予防的な位置づけ」は research.md「実現性/リスク」節（F番号なし）が
  出典なのに F6（0x1E の実機未目撃という別の事実）を引用していた。それぞれ正しい
  出典に修正した。
  — 根拠: `packages/tn5250/src/protocol/constants.ts`（`UNKNOWN_1C`/`UNKNOWN_1E` の doc コメント）
- T1 (nit): `ORDER` オブジェクトのバイト値昇順（0x01…0x15,0x1c,0x1d）が、
  `UNKNOWN_1E`（0x1e）を `SF`（0x1d）より前に挿入したことで崩れていた
  （機能的な副作用は無い——`Object.keys/values` の列挙順に依存するコードは
  リポジトリ内に無いことを確認済み）。`UNKNOWN_1E` を `SF` の後ろへ移動し、
  昇順（0x1c, 0x1d, 0x1e）を回復した。
  — 根拠: `packages/tn5250/src/protocol/constants.ts`（`ORDER` オブジェクト）
- T2: 指摘なし（`CHECK: ok`）。`buf.setChar` の呼び出し方が既存の `UNKNOWN_1C` と
  型・引数・rawByte 省略判断のいずれも一致していることを確認済み。
- T3: 指摘なし（`CHECK: ok`）。差し替え後も検証内容（ESC 誤認識の回避）が
  維持されていることを確認済み。
- T4 (should x2): (1) 新規テストの「同じレコード内にある WRITE_TO_DISPLAY の
  CC2・READ も失われない」というアサーション（`unlockKeyboard`/`readRequested`）が、
  実は修正前のコードでもこのテストデータでは true になり、回帰を検出しない
  ことが判明した（CC2 は WTD 本体の走査より前に無条件適用される。READ 側も
  `default:` の復帰ループが偶然正しく resync してしまう）。この2アサーションと
  誤解を招くコメントを削除し、`ORDER.UNKNOWN_1C` の既存テストと同じ構成
  （`rowText` で "A;B" を確認する形）に書き直した。
  (2) `ORDER.UNKNOWN_1C` の対応する既存テストには `rawByte` が undefined である
  ことの確認（カタカナ表示モードでの誤再解釈を防ぐ）があるのに、対称のはずの
  0x1E テストにはこの検証が無かった。`rawByte` の確認を追加し、`UNKNOWN_1C` と
  対称なテスト構成にした。
  — 根拠: `packages/tn5250/test/wtd-applier.test.ts`（0x1E の新規テスト）
