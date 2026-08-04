# 決定記録

## D1: 折りたたみの自動展開を `setActiveTab` の 1 か所に置く（spec §8 の 2 ファイル修正をやめた）

- 背景: spec §8 は「折りたたみ中のタブを `LauncherPane` / `openConfigured` が前面に出したら展開する」
  としていた。実装に入って数えると、同じ形（`setActiveTab` ＋ `focus`）が **4 か所**あった——
  `LauncherPane.openFeature` / `LauncherPane.openWatchConsole` / `openConfigured.focusSession` /
  `App.openAdmin`。
- 決定: 呼び出し側を触らず、**`workspaceStore.setActiveTab` の中で `revealTab` を呼ぶ**。
- 理由 / 代替案: 4 か所へ同じ分岐を配ると、5 か所目を足したときに「開いているのに出てこない」が
  再発する。これは `paneLabels.ts` が `PANE_PREFIXES` を 1 か所へ集約した理由そのもの
  （`list:` の追加漏れでタブのクローズが壊れた前例）。
  `setActiveTab` を通るのは「そのタブを見せてくれ」という要求だけなので、意味的にも正しい位置。
  **`activeTab` を直接書く経路（`cycleTab` / `dropTabInto` / `groupTabs` / `moveTabGroupInto`）は
  展開しない**——折りたたみが勝手に解けないようにするため（「畳んだチップへ落としても畳んだまま」
  という要件がここに乗る）。
- 影響: spec §8 の当該行は「`setActiveTab` に集約」と読み替える。tasks.md の T11 も同様。
  変更ファイルは 2 つ減り、`stores/workspace.ts` に閉じた。
