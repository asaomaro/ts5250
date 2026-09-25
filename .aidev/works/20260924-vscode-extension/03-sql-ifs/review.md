# レビュー記録

## タスク点検ログ（coding 工程内・「3.3」(b)）

### T1: systemSync.ts（same_session）

- [should][conv:-] `PUT`が非2xxを返したとき、404以外（500等の一時的な障害）まで
  無条件で`POST`（新規登録）へフォールバックしていた。失敗のたびに孤児システムが
  増え続け、本当のエラーが見えなくなる / 対応: 修正済（`res.status === 404`のときだけ
  フォールバックし、それ以外は例外を投げるよう変更。回帰テスト追加）
- [must][conv:-] `POST`/`PUT /api/systems`の応答形状を`{system:{id}}`だと思い込んで
  実装しており、単体テストのモックも同じ誤った形状で書いていたため通っていたが、
  実際のサーバー応答は`{system:{ref}}`（`ref`は既に`own:s-xxx`の形。`id`という欄は
  無い）だった。実装は常に`own:undefined`という壊れた参照を返し、以後のシステム
  参照が全て機能しない状態だった——**T3（実プロセス統合テスト）を書いて実際に
  起動したサーバーへ当てて初めて発覚**（単体テストは自分の誤った思い込みを
  そのままモックにしていたため、この欠陥を1件も拾えなかった） / 対応: 修正済
  （`json.system.ref`をそのまま使う。PUT時のURL構築・対応表のキャッシュも
  `own:`を自前で組み立てず、サーバーが返した`ref`をそのまま使うよう統一。
  単体テストのモック応答形状も実際の形に合わせて修正した）

### T2: ts5250EditorProvider.tsのsystemSync統合（delegated）

- [should][conv:-] `handleSave`が`app !== "emulator"`（printer/sql/ifs）を保存した
  経路のテストが無かった。「新規暗号化したpasswordEncを書き込む→resolvePayloadで
  同じ値を復号・剥離しsyncSystemへ平文を渡す」という本タスクで最もリスクが高い
  合流点が回帰資産化されていなかった / 対応: 修正済（save→非emulatorの経路を
  検証するテストを追加。ファイルへの暗号化書き込み・syncSystemへ渡る新鮮な平文・
  savedのpayloadからuser/passwordが剥離されることを1テストで確認）
- [should][conv:-] 「systemRef解決」のテストがいずれも`signon.passwordEnc`を
  含まないフィクスチャしか使っておらず、`delete payload.password`が実際に
  復号された平文パスワードを剥離することを直接検証していなかった（`user`剥離との
  対称性からの類推でしか裏付けられていなかった） / 対応: 修正済（実在する
  passwordEncを含むフィクスチャで、syncSystemへは復号済み平文が渡り、
  WebViewへのconnect payloadからは完全に除去されることを確認するテストを追加）

### T3: systemSync実プロセス統合テスト（same_session）

指摘なし。この統合テストがT1のmust級バグ（応答形状の思い込み違い）を発見した
当のテストである。

## ラウンド 1（2026-09-25T01:25:00Z）

被覆（`aidev coverage`）: gap 0（struct=0, cover=0。`ac=14 design=14/14 tasks=14/14`）。

**要件適合・価値適合**:
- AC8（プリンター(スプール表示)・SQL・IFSが動く状態）は、個人設定の登録・同期という
  「system参照を要求するREST層」への橋渡しが、実プロセスへの実際のHTTPリクエストで
  確認できている。単体テストの応答モックが誤っていてもテストは通ってしまう
  （taskcheck T1のmustが実証した）という、この種のAPI統合コードに特有のリスクを
  実プロセス統合テストで塞いだ

**規約適合・保守性**: taskcheck（T1〜T3・cross）で計4件の指摘を検出・修正済み
（must 1・should 3）。このラウンドの再点検で新規のmust/shouldは見つからなかった。

**AGENTS.md規約の確認**:
- 秘密: `syncSystem`が平文パスワードをネットワーク（loopback）へ送るのは
  design.md「設計方針3」で承認済みの経路。ログ・ファイルへの平文書き込み箇所は無い
  （grep確認済み。test-result.md参照）
- `Ts5250EditorProviderDeps`の拡張（`syncSystem`/`log`）は既存の依存注入パターン
  （`acquireService`/`releaseService`）と同じ形を踏襲している

指摘なし（このラウンドではmust/should 0件）。
