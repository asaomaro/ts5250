# 仕様: 監視の元を「メニュー中は undefined」にする

## 設計方針

`App.vue` の追従を、`showLauncher` の立ち上がりではなく
**「いま見ているタブのシステム」そのもの**の監視に変える。

```ts
watch(
  () => (showLauncher.value ? undefined : workspaceStore.systemOf(workspaceStore.focusedGroup().activeTab)),
  (sys) => { if (sys) systemsStore.select(sys); },
  { immediate: true }
);
```

- **監視の元にメニューの状態を織り込む**のが要点。メニューを出している間は `undefined` に
  なるので、その間の更新が止まる（`20260802-tabs-own-system` の「開いた時点で固定」を維持）。
- `undefined` のときは何もしない——これがそのまま
  「システムを持たないタブでは直前の対象を維持」にもなる。
- 元は `focusedGroup().activeTab` に依るので、**タブの選び替えにもペインの移動にも**追従する。

## 対象範囲

- `App.vue`（追従の監視 1 か所）

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| タブを選び替えると変わる | 監視の元が `activeTab` |
| ペインを移しても追う | 元が `focusedGroup()` に依る |
| メニュー中は動かない | 元がメニュー中は `undefined` |
| システム無しのタブでは維持 | `undefined` では何もしない |
