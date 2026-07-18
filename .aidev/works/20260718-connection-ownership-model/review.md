# レビュー記録

## ラウンド 1（2026-07-18）

差分（server: profiles / connection-store / settings-move / app、web-ui: ConnectView、README、テスト）を
要件適合・セキュリティ・正確性で点検した。

### セキュリティ（重点）
- **printer 出力の受理**: `buildProfile` が実効種別を決め、`display` では printer を**必ず落とす**。加えて受理経路は
  canEditProfiles（認証オフ or admin ＋ persistable）ルート限定のまま。→ 5250端末に信頼設定が混入しない。
- **個人に信頼設定を持たせない**: `ConnectionRecord` に printer フィールドは存在せず、`shared→personal` の移動では
  printer を破棄（warning）。個人はプリンター種別でも自動出力を持てない（Q3 決定どおり）。
- **所有移動は admin 限定**: `/api/settings/move` に `requireAdmin()`。一般ユーザー 403 をテストで固定。
- **秘密の移送**: `secretEnc`（個人）と `signon.passwordEnc`（共有）は同一 AES-256-GCM 形式のため文字列移送で安全。
  `passwordEnv`（env 参照）は個人へ移せないため破棄し warning を返す（黙って壊さない）。
- **移動の原子性**: personal→shared は「profile 追加（同名は 409）→ connection 削除」の順で、失敗時に元が残る。

### 要件適合
- 種別は新規で確定・更新で不変（profile は effectiveType(keep)、connection は existing.sessionType）。テスト固定。
- PDF 出力欄は「プリンター種別 × 共有 × editor」のみ表示（コンポーネントテストで固定）。
- 認証オフは所有ラベル・所有選択を出さず全て共有。admin は選択と共有⇄個人の移動が可能。一般は個人のみ。

### 発見と修正（このラウンドで対応）
- [should→修正済] **認証オフ＋`--profiles` 未指定**（共有が書き込めない構成）で、新規作成が共有プロファイルへ向かい
  403 になるエッジケースがあった。→ `profilesEditable` を条件に加え、共有が使えない構成では**個人接続へフォールバック**。
  回帰テスト（editable=false で編集ボタンなし・新規は `/api/connections` へ POST）を追加。
- [修正済] `editProfile` が `sessionType` を引き継いでおらず、プリンタープロファイル編集で PDF 欄が出なかった。
  → 追加したコンポーネントテストが検出し修正。

### 指摘（残）
- [nit] shared→personal の移動先 owner は「操作した admin」に固定（他ユーザーへの割当は不可）。要件外につき許容。
- [nit] 移動は「追加→削除」の 2 段で、削除が失敗すると重複が残り得る（実質は同一プロセス内で成功する）。許容。

### 判定
must: 0 件。should: 1 件（このラウンドで修正済み）。nit: 2 件（許容）。→ review 通過。
