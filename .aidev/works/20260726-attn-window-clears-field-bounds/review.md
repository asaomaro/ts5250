# レビュー記録

## ラウンド 1（2026-07-26）

差分: `buffer.ts`（+31/-2）＋新規テスト 1 本＋`docs/PROTOCOL.md` 5 行。

### 要件適合

- 完了条件 7 件すべてに検証がある（test.md の対応表）。対象外（境界付け方式の見直し／ホストへの介入／
  入力の扱い）には踏み込んでいない——差分は `buffer.ts` の表示境界のみ。

### 正確性

- ライフサイクルが要件どおり: `addField` で記録 / `clearFormatTable` は**触らない** /
  `clearUnit`・`resize` で消す / `saveScreen`・`restoreScreen` で退避・復元。
- **重なり判定** `s0 < end && startAddr < e0` は標準的な区間交差。`s0 !== startAddr` を除いているのは、
  同一開始アドレスの再定義を直後の `set` で上書きさせるため（先に消すと無駄）。
- `saveScreen` は `new Map(...)` でコピーを積む（参照共有すると復元後に壊れる）。`restoreScreen` は
  pop したものをそのまま持つ——スタックから外れているので共有にならない。`cells`/`fields` と同じ流儀。
- `snapshot()` の `fieldEnds` は `attrBounds.values()` の Set。**`fields` 由来の唯一の参照箇所**だった
  ことを確認済み（他に `fields` から境界を導いている場所は無い）。

### 規約適合（AGENTS.md）

- コメントは意図中心。「なぜ `fields` と別に持つか」「なぜ SOH で消さないか」「なぜ重なりで捨てるか」が
  実機の観測値（44 → 2）付きで残っている。
- core のピュアロジック層に閉じ、`node:*` の追加なし。`docs/PROTOCOL.md` 4.3 に規約として明文化した。

### 指摘

- **[nit]** `attrBounds` の宣言位置が `rowColOf` と `savedStack` の間で、フィールド群からやや離れている。
  ただし `savedStack` の直前＝退避対象の並びとしては自然なので**そのまま**とする。
- **[観測されていない残リスク]** EA（Erase to Address）で消した領域の境界は残る。そこへホストが
  新たに下線を引くと早く切れうる。実機では観測しておらず、対処すると「消し方」ごとに規則が増えるため
  今回は入れない（test.md に残リスクとして記載）。

### 判定

must 0 / should 0 / nit 1（許容）→ **通過**。
