import { reactive } from "vue";
import { isPaneTab, splitPaneTabId } from "../paneLabels.js";
import { nextTabGroupColor, tabGroupColorIndex } from "../composables/tabGroupColor.js";

/** 分割ツリー: split（縦/横・比率）または group（タブ群）。「タブだけ」は深さ 1 の group */
export interface SplitNode {
  type: "split";
  dir: "row" | "col";
  ratio: number; // a の比率（0〜1）
  a: WsNode;
  b: WsNode;
}
export interface GroupNode {
  type: "group";
  id: string;
  tabs: string[]; // sessionId の並び
  activeTab: string | undefined;
}
export type WsNode = SplitNode | GroupNode;

export type DropZone = "center" | "top" | "bottom" | "left" | "right";

/**
 * **タブグループ**（`20260804-tab-groups`）——タブ帯の中で作業ごとにタブをまとめる単位。
 *
 * **`GroupNode`（＝ペイン）とは別物**。この木では歴史的に「group」がペインを指しており
 * （`groups()` / `focusedGroupId` / `.group[data-group-id]`）、同じ語を重ねると読めなくなるので、
 * こちらは一貫して `TabGroup` / `tabGroup*` / `tg-*` と呼ぶ。
 *
 * 所属は `tabs` 配列ではなく**別表**（`tabGroupOf`）で持つ。`tabs: string[]` の要素型を変えると
 * `liveTabs`（`WorkspaceNode`）・`PanePool.entries`・`cycleTab` など文字列前提の消費者すべてに
 * 波及するため。同じ問題を `tabSystem` が同じ形で解いている。
 */
export interface TabGroup {
  id: string;
  /** 表示名。`""` は未設定（チップは色だけになる） */
  name: string;
  /** パレット番号（1..TAB_GROUP_COLOR_COUNT）。色の実体は CSS 変数側 */
  color: number;
  /**
   * 折りたたみ中か。**タブ帯の見せ方だけ**の状態で、`tabs` にも `activeTab` にも干渉しない
   * （畳んだグループの中のタブがアクティブなら、その中身は出続ける。利用者の判断）。
   */
  collapsed: boolean;
}

let gid = 0;
let tgid = 0;
const newGroup = (tabs: string[] = []): GroupNode => ({
  type: "group",
  id: `g${++gid}`,
  tabs,
  activeTab: tabs[0]
});

function groups(node: WsNode, acc: GroupNode[] = []): GroupNode[] {
  if (node.type === "group") acc.push(node);
  else {
    groups(node.a, acc);
    groups(node.b, acc);
  }
  return acc;
}

/** node 内で group を探し、親と自身の位置を返す（置換用） */
function findGroup(root: WsNode, id: string): GroupNode | undefined {
  return groups(root).find((g) => g.id === id);
}

/** node ツリー中の target group を replacement で置き換える（新ツリーを返す） */
function replace(node: WsNode, targetId: string, replacement: WsNode): WsNode {
  if (node.type === "group") return node.id === targetId ? replacement : node;
  return { ...node, a: replace(node.a, targetId, replacement), b: replace(node.b, targetId, replacement) };
}

/**
 * 同じタブグループのタブを**隣り合わせに寄せた**並びを返す（`spec.md` §1 の 4.）。
 *
 * グループの位置は「**最初のメンバーが居た場所**」で、そこへ残りを現在の相対順のまま引き寄せる。
 * 前寄せにするのは、掴んで動かしたタブの位置がグループ全体を引きずらないようにするため。
 */
function contiguousTabs(tabs: string[], of: Record<string, string>): string[] {
  const out: string[] = [];
  const done = new Set<string>();
  for (const t of tabs) {
    if (done.has(t)) continue;
    const tg = of[t];
    if (tg === undefined) {
      out.push(t);
      done.add(t);
      continue;
    }
    for (const m of tabs) {
      if (of[m] === tg && !done.has(m)) {
        out.push(m);
        done.add(m);
      }
    }
  }
  return out;
}

/** target group を削除し、兄弟を昇格させる（空グループの片付け）。ルートが空なら空 group を残す */
function removeGroup(node: WsNode, targetId: string): WsNode | undefined {
  if (node.type === "group") return node.id === targetId ? undefined : node;
  const a = removeGroup(node.a, targetId);
  const b = removeGroup(node.b, targetId);
  if (a && b) return { ...node, a, b };
  return a ?? b; // 片方が消えたら残りを昇格
}

export const workspaceStore = reactive({
  root: newGroup() as WsNode,
  focusedGroupId: "" as string,
  /**
   * タブ ID → 所属システムの参照。**タブの可視判定に使う唯一の情報源**。
   * `GroupNode.tabs` は文字列 ID しか持たず、`admin:*` / `list:*` はセッションも持たないため、
   * 対応表を別に持つ以外に辿る手段がない。
   */
  tabSystem: {} as Record<string, string>,
  /** ランチャー（メニュー）を前面に出すか */
  showLauncher: false,
  /** システム選択画面を出すか。**選択を外さずに一覧を見せる**ための状態 */
  showSystemPicker: false,
  /** 狭幅時は分割を無効化し単一グループにフォールバック（Workspace が set） */
  narrow: false,
  /**
   * 最大化中のグループ。設定されている間はそのグループだけを描画する。
   *
   * **ツリー（root）は書き換えない**——一時的な見せ方の切り替えなので、元に戻すのは
   * この ID を消すだけで済む。分割の比率も配置もそのまま残る。
   */
  maximizedGroupId: undefined as string | undefined,
  /** D&D 中のタブ（sessionId）。PaneTabs 間で共有し、自グループ内の並び替えか判定する */
  draggingSession: undefined as string | undefined,
  /**
   * **タブグループの定義**（id → 名前・色・折りたたみ）。`20260804-tab-groups`
   */
  tabGroups: {} as Record<string, TabGroup>,
  /**
   * **タブ ID → 所属タブグループ id**。`tabSystem` と同じ「別表」方式（`TabGroup` の注記参照）。
   * ここに載っていないタブは、どのグループにも属さない。
   */
  tabGroupOf: {} as Record<string, string>,
  /**
   * D&D 中のタブグループ（チップを掴んでいる間）。
   *
   * **`draggingSession` に混ぜない**——あちらは「このペインのタブか」の判定に使われており
   * （`PaneTabs` の合流ハイライト）、グループ id を入れると誤作動する。
   */
  draggingTabGroup: undefined as string | undefined,
  init(): void {
    this.root = newGroup();
    this.focusedGroupId = (this.root as GroupNode).id;
    this.maximizedGroupId = undefined;
    this.tabGroups = {};
    this.tabGroupOf = {};
    this.draggingTabGroup = undefined;
  },

  /** ペイン分割されているか（＝最大化ボタンを出す条件） */
  isSplit(): boolean {
    return this.root.type === "split";
  },

  /**
   * そのタブを持っているグループ（無ければ `undefined`）。
   *
   * ペインの実体は `PanePool` が 1 か所で持ち、`<Teleport>` でグループ側の受け皿へ
   * 差し込む（`20260802-keep-pane-state-move`）。プールが「いまどこへ差すか」を
   * 決めるのにこれを使う。
   */
  groupOf(tab: string): GroupNode | undefined {
    return groups(this.root).find((g) => g.tabs.includes(tab));
  },

  /**
   * **そのタブのシステム**（`20260802-tabs-own-system`）。
   *
   * アプリ系タブは**タブ ID そのもの**が持つ（`sql:query@own:a`）。セッション系タブ
   * （5250・プリンター）は ID を変えないので、従来どおり `tabSystem` から引く。
   *
   * **引き方をここ 1 か所に閉じる**のが要点。以前はアプリ系ペインが 6 か所で
   * `systemsStore.selected`（当時の名前。アプリ全体で 1 つの値）を読んでいて、
   * **画面に出ているシステムと要求の宛先が食い違いうる**状態だった。
   */
  systemOf(tab: string | undefined): string | undefined {
    if (!tab) return undefined;
    if (isPaneTab(tab)) return splitPaneTabId(tab).system;
    return this.tabSystem[tab];
  },

  /** 指定グループの最大化を切り替える。分割されていないときは何もしない */
  toggleMaximize(groupId: string): void {
    if (this.maximizedGroupId === groupId) {
      this.maximizedGroupId = undefined;
      return;
    }
    if (!this.isSplit()) return;
    if (!findGroup(this.root, groupId)) return;
    this.maximizedGroupId = groupId;
    this.focusedGroupId = groupId;
  },

  /**
   * 最大化を維持できない状態なら解除する。
   * グループが消えた／分割が無くなった（＝最大化する意味が無い）ときに呼ぶ。
   */
  syncMaximized(): void {
    const id = this.maximizedGroupId;
    if (id === undefined) return;
    if (!this.isSplit() || !findGroup(this.root, id)) this.maximizedGroupId = undefined;
  },

  groups(): GroupNode[] {
    return groups(this.root);
  },

  focusedGroup(): GroupNode {
    return findGroup(this.root, this.focusedGroupId) ?? this.groups()[0]!;
  },

  focus(groupId: string): void {
    this.focusedGroupId = groupId;
  },

  /**
   * セッションをフォーカス中グループのタブとして追加（狭幅時も同様）。
   *
   * @param systemRef このタブが属するシステム。**タブ ID は所属を持たない**ので、
   *   ここで対応表に記録する。`admin:*` / `list:*` はセッションを持たず辿れないため、
   *   開いた時点の選択中システムを渡す。
   */
  addSession(sessionId: string, systemRef?: string): void {
    const g = this.focusedGroup();
    if (!g.tabs.includes(sessionId)) g.tabs.push(sessionId);
    g.activeTab = sessionId;
    this.focusedGroupId = g.id;
    if (systemRef !== undefined) this.tabSystem[sessionId] = systemRef;
  },

  /**
   * **システムによる絞り込みはしない**（`20260802-tabs-own-system`）。
   *
   * 以前は選択中システムのタブだけを出していた。**異なるシステムのタブを並べて
   * 同時に見たい**という要望に対し、それは真っ向から邪魔になる。
   * 見分けはタブの色帯とシステム名が担う（`PaneTabs`）。
   *
   * 実配列を返さないのは従来どおり——呼び出し側が結果を書き換えても group が壊れないように。
   *
   * **折りたたみは別軸**（`20260804-tab-groups`）。システムによる絞り込みは戻さないが、
   * 畳んだタブグループのメンバーはここで落とす——**タブ帯の描画はここが唯一の継ぎ目**で、
   * `tabs` から外して隠すと `PanePool` の母集合から落ちてペインの実体が消える
   * （書きかけの SQL が失われる）。隠すのはここ、持ち物は `tabs`、と役割を分ける。
   */
  visibleTabs(g: GroupNode): string[] {
    return g.tabs.filter((t) => {
      const tg = this.tabGroupOf[t];
      return tg === undefined || this.tabGroups[tg]?.collapsed !== true;
    });
  },

  /** タブの所属システムを記録する（セッション確立後など、後から分かる場合） */
  assignSystem(sessionId: string, systemRef: string): void {
    this.tabSystem[sessionId] = systemRef;
  },

  // ---- タブグループ（`20260804-tab-groups`） ----

  /**
   * **タブグループの不変条件を回復する。単一の置き場**（`spec.md` §1）。
   *
   * `tabs` を触るすべての操作の**末尾で呼ぶ**——`dropTabInto` / `moveTab` / `split` /
   * `closeSession` / `groupTabs` / `moveTabGroupInto` / `splitWithTabGroup`。
   * `pruneEmpty()` が全経路から呼ばれているのと同じ理由で、UI 側に散らすと
   * 「その経路だけ解除されない」が必ず出る（`split` 経由の離脱を取りこぼした、など）。
   *
   * 回復するもの:
   * 1. **迷子の所属**——どのペインにも居ないタブの所属を捨てる（閉じたタブの残骸）。
   * 2. **1 ペインに収める**（INV-TG1）——グループが 2 ペインに跨っていたら、最初に見つかった
   *    ペイン側だけを残す。跨がせないのは、チップの置き場所が一意に決まらなくなるため。
   * 3. **1 枚以下のグループを解除**——まとまりの意味が無くなったら器を残さない（requirement 4）。
   * 4. **連続化**——グループの途中に外のタブが割り込まない（requirement 5）。
   */
  normalizeTabGroups(): void {
    const panes = this.groups();
    const live = new Set<string>();
    for (const p of panes) for (const t of p.tabs) live.add(t);
    // 1. 迷子の所属
    for (const t of Object.keys(this.tabGroupOf)) {
      if (!live.has(t)) delete this.tabGroupOf[t];
    }
    // 2. 1 ペインに収める（最初に現れたペインが持ち主）
    const owner: Record<string, string> = {};
    for (const p of panes) {
      for (const t of p.tabs) {
        const tg = this.tabGroupOf[t];
        if (tg === undefined) continue;
        if (owner[tg] === undefined) owner[tg] = p.id;
        else if (owner[tg] !== p.id) delete this.tabGroupOf[t];
      }
    }
    // 3. メンバー数を数え、1 枚以下なら解除
    const members: Record<string, string[]> = {};
    for (const p of panes) {
      for (const t of p.tabs) {
        const tg = this.tabGroupOf[t];
        if (tg !== undefined) (members[tg] ??= []).push(t);
      }
    }
    for (const [tg, ts] of Object.entries(members)) {
      if (ts.length <= 1) for (const t of ts) delete this.tabGroupOf[t];
    }
    for (const id of Object.keys(this.tabGroups)) {
      if ((members[id]?.length ?? 0) <= 1) delete this.tabGroups[id];
    }
    // 4. 連続化（変化したペインだけ差し替える）
    for (const p of panes) {
      const next = contiguousTabs(p.tabs, this.tabGroupOf);
      if (next.some((t, i) => t !== p.tabs[i])) p.tabs = next;
    }
  },

  /** そのタブが属するタブグループ（無ければ undefined）。`systemOf` と同じ位置づけ */
  tabGroupOfTab(tab: string | undefined): TabGroup | undefined {
    if (!tab) return undefined;
    const id = this.tabGroupOf[tab];
    return id === undefined ? undefined : this.tabGroups[id];
  },

  /** そのグループのタブを**タブ帯の並び順**で返す（閉じる・移動するときの対象） */
  tabGroupTabs(tgId: string): string[] {
    for (const p of this.groups()) {
      const hit = p.tabs.filter((t) => this.tabGroupOf[t] === tgId);
      if (hit.length > 0) return hit;
    }
    return [];
  },

  /** そのグループが載っているペイン（INV-TG1 によりたかだか 1 つ） */
  paneOfTabGroup(tgId: string): GroupNode | undefined {
    return this.groups().find((p) => p.tabs.some((t) => this.tabGroupOf[t] === tgId));
  },

  /**
   * タブを重ねてグループ化する（`targetTab` の上に `draggedTab` を落とした）。
   * `targetTab` が既にグループなら**そこへ参加**、そうでなければ 2 枚で**新規作成**する。
   * 別ペインから来たタブは、対象ペインの `targetTab` の直後へ移してから参加させる。
   */
  groupTabs(paneId: string, targetTab: string, draggedTab: string): void {
    if (targetTab === draggedTab) return;
    const to = findGroup(this.root, paneId);
    if (!to || !to.tabs.includes(targetTab)) return;
    const from = this.groups().find((g) => g.tabs.includes(draggedTab));
    if (!from) return;
    let tg = this.tabGroupOf[targetTab];
    if (tg === undefined) {
      tg = `tg${++tgid}`;
      this.tabGroups[tg] = {
        id: tg,
        name: "",
        color: nextTabGroupColor(Object.values(this.tabGroups).map((g) => g.color)),
        collapsed: false
      };
      this.tabGroupOf[targetTab] = tg;
    }
    from.tabs = from.tabs.filter((t) => t !== draggedTab);
    if (from.activeTab === draggedTab) from.activeTab = from.tabs[0];
    const rest = to.tabs.filter((t) => t !== draggedTab);
    rest.splice(rest.indexOf(targetTab) + 1, 0, draggedTab);
    to.tabs = rest;
    this.tabGroupOf[draggedTab] = tg;
    // **畳んだグループへ入れたときは表示を変えない**——隠れているタブをアクティブにすると
    // 「何も選んでいないのに中身が変わった」ように見える（`moveTabGroupInto` と同じ規則）
    if (this.tabGroups[tg]?.collapsed !== true) to.activeTab = draggedTab;
    else to.activeTab ??= draggedTab;
    this.focusedGroupId = to.id;
    if (from !== to && from.tabs.length === 0) this.pruneEmpty();
    this.normalizeTabGroups();
  },

  /** グループ化を解除する（**タブは残す**。並びもそのまま） */
  ungroupTabGroup(tgId: string): void {
    for (const t of Object.keys(this.tabGroupOf)) {
      if (this.tabGroupOf[t] === tgId) delete this.tabGroupOf[t];
    }
    delete this.tabGroups[tgId];
  },

  /** 折りたたみ / 展開。**タブにも activeTab にも触らない**（見せ方だけ） */
  toggleTabGroupCollapsed(tgId: string): void {
    const tg = this.tabGroups[tgId];
    if (tg) tg.collapsed = !tg.collapsed;
  },

  /** 折りたたみを解除する（畳んだ中のタブを前面に出すときに使う） */
  expandTabGroup(tgId: string): void {
    const tg = this.tabGroups[tgId];
    if (tg) tg.collapsed = false;
  },

  /** そのタブが畳まれたグループの中にあれば展開する（`LauncherPane` などの「既に開いている」経路用） */
  revealTab(tab: string): void {
    const id = this.tabGroupOf[tab];
    if (id !== undefined) this.expandTabGroup(id);
  },

  renameTabGroup(tgId: string, name: string): void {
    const tg = this.tabGroups[tgId];
    if (tg) tg.name = name;
  },

  setTabGroupColor(tgId: string, color: number): void {
    const tg = this.tabGroups[tgId];
    if (tg) tg.color = tabGroupColorIndex(color, tg.color);
  },

  /** グループごと別ペインのタブ帯へ合流させる（名前・色・折りたたみ・並びを保つ） */
  moveTabGroupInto(toPaneId: string, tgId: string): void {
    const to = findGroup(this.root, toPaneId);
    const from = this.paneOfTabGroup(tgId);
    if (!to || !from || from === to) return;
    const members = this.tabGroupTabs(tgId);
    if (members.length === 0) return;
    from.tabs = from.tabs.filter((t) => !members.includes(t));
    if (from.activeTab !== undefined && members.includes(from.activeTab)) from.activeTab = from.tabs[0];
    to.tabs = [...to.tabs.filter((t) => !members.includes(t)), ...members];
    // **畳んだグループを落としても表示は変えない**——隠れているタブをアクティブにすると
    // 「何も選んでいないのに中身が変わった」ように見える。展開中のときだけ先頭を出す
    if (this.tabGroups[tgId]?.collapsed !== true) to.activeTab = members[0];
    else to.activeTab ??= members[0];
    this.focusedGroupId = to.id;
    if (from.tabs.length === 0) this.pruneEmpty();
    this.normalizeTabGroups();
  },

  /**
   * グループごとペインを分割して移す（端ドロップ）。
   * **狭幅・最大化中は分割せず合流へ倒す**——単独タブの `split()` と同じ方針。
   */
  splitWithTabGroup(paneId: string, zone: Exclude<DropZone, "center">, tgId: string): void {
    if (this.maximizedGroupId !== undefined || this.narrow) {
      this.moveTabGroupInto(paneId, tgId);
      return;
    }
    const target = findGroup(this.root, paneId);
    if (!target) return;
    const members = this.tabGroupTabs(tgId);
    if (members.length === 0) return;
    for (const g of this.groups()) {
      if (!g.tabs.some((t) => members.includes(t))) continue;
      g.tabs = g.tabs.filter((t) => !members.includes(t));
      if (g.activeTab !== undefined && members.includes(g.activeTab)) g.activeTab = g.tabs[0];
    }
    const fresh = newGroup(members);
    const dir: "row" | "col" = zone === "left" || zone === "right" ? "row" : "col";
    const newFirst = zone === "left" || zone === "top";
    this.root = replace(this.root, paneId, {
      type: "split",
      dir,
      ratio: 0.5,
      a: newFirst ? fresh : target,
      b: newFirst ? target : fresh
    });
    this.focusedGroupId = fresh.id;
    this.pruneEmpty();
    this.normalizeTabGroups();
  },

  /**
   * タブをアクティブにする。
   *
   * **畳んだタブグループの中なら展開する**（`20260804-tab-groups`）。ここを通るのは
   * 「そのタブを見せてくれ」という要求（タブのクリック／ランチャーの「表示」／管理タブを開く／
   * `focusSession`）だけで、**見せると言われた以上、タブ帯にも出す**のが筋。
   *
   * **展開をこの 1 か所に置く**のが要点。呼び出し側 4 か所に同じ分岐を書くと、
   * 5 か所目を足したときに「開いているのに出てこない」が再発する（`paneLabels.ts` と同じ教訓）。
   *
   * 逆向き（`activeTab` を直接書く経路＝`cycleTab` / ドロップ / グループ移動）は**展開しない**。
   * 折りたたみは見せ方だけの状態なので、勝手に解けないようにする。
   */
  setActiveTab(groupId: string, sessionId: string): void {
    const g = findGroup(this.root, groupId);
    if (!g || !g.tabs.includes(sessionId)) return;
    g.activeTab = sessionId;
    this.revealTab(sessionId);
  },

  /**
   * タブを targetGroup の toIndex 位置へ落とす（グループ内並び替え／別グループからの合流の両対応）。
   * toIndex は「ドラッグ中タブを除いた targetGroup.tabs 配列」での挿入位置（0〜末尾）。
   * 別グループからの合流時は元グループから取り除き、空になれば片付ける。
   */
  dropTabInto(targetGroupId: string, sessionId: string, toIndex: number): void {
    const to = findGroup(this.root, targetGroupId);
    if (!to) return;
    const from = this.groups().find((g) => g.tabs.includes(sessionId));
    if (!from) return;
    // 元グループから取り除く（to===from なら同じ配列を更新）
    from.tabs = from.tabs.filter((t) => t !== sessionId);
    if (from.activeTab === sessionId) from.activeTab = from.tabs[0];
    // 挿入位置へ差し込む
    const rest = to.tabs.filter((t) => t !== sessionId);
    const at = Math.max(0, Math.min(toIndex, rest.length));
    /**
     * **タブグループへの出入りは「着地点の両隣」で決める**（`20260804-tab-groups`）。
     *
     * 両隣が同じグループ＝グループの内側へ落ちた＝参加。それ以外（端・外・別ペイン）は離脱。
     * 落とした場所だけで決まるので、利用者は「どこへ落とすか」以外を覚えなくてよい。
     * 別ペインへ移したときに必ず抜けるのも、これで自然に導かれる
     * （移り先の隣人は元のグループではありえない＝INV-TG1）。
     */
    const leftTg = at > 0 ? this.tabGroupOf[rest[at - 1]!] : undefined;
    const rightTg = at < rest.length ? this.tabGroupOf[rest[at]!] : undefined;
    if (leftTg !== undefined && leftTg === rightTg) this.tabGroupOf[sessionId] = leftTg;
    else delete this.tabGroupOf[sessionId];
    rest.splice(at, 0, sessionId);
    to.tabs = rest;
    to.activeTab = sessionId; // 落としたタブをアクティブに
    this.focusedGroupId = to.id;
    if (from !== to && from.tabs.length === 0) this.pruneEmpty();
    this.normalizeTabGroups();
  },

  /** フォーカス中グループのアクティブタブを次(dir=1)/前(dir=-1)へ循環（タブ<2 なら無操作） */
  cycleTab(dir: 1 | -1): void {
    const g = this.focusedGroup();
    if (g.tabs.length < 2 || !g.activeTab) return;
    const i = g.tabs.indexOf(g.activeTab);
    if (i < 0) return;
    g.activeTab = g.tabs[(i + dir + g.tabs.length) % g.tabs.length];
  },

  /** タブを別グループへ移動（中央ドロップ＝合流） */
  moveTab(sessionId: string, toGroupId: string): void {
    const from = this.groups().find((g) => g.tabs.includes(sessionId));
    const to = findGroup(this.root, toGroupId);
    if (!from || !to || from === to) return;
    from.tabs = from.tabs.filter((t) => t !== sessionId);
    if (from.activeTab === sessionId) from.activeTab = from.tabs[0];
    to.tabs.push(sessionId);
    to.activeTab = sessionId;
    delete this.tabGroupOf[sessionId]; // 別ペインへ移ったタブはグループから抜ける（INV-TG1）
    if (from.tabs.length === 0) this.pruneEmpty();
    this.normalizeTabGroups();
  },

  /** グループを方向に分割し、sessionId を新グループに置く（端ドロップ＝分割。狭幅時は合流にフォールバック） */
  split(groupId: string, zone: Exclude<DropZone, "center">, sessionId: string): void {
    // 最大化中は分割しない。分割すると「最大化した 1 枚」の中に入れ子ができ、
    // 元に戻したときの形が予測できなくなる（タブ移動だけ許す）
    if (this.maximizedGroupId !== undefined) {
      this.moveTab(sessionId, groupId);
      return;
    }
    if (this.narrow) {
      this.moveTab(sessionId, groupId);
      return;
    }
    const target = findGroup(this.root, groupId);
    if (!target) return;
    // 元グループから sessionId を除く
    for (const g of this.groups()) {
      if (g.tabs.includes(sessionId)) {
        g.tabs = g.tabs.filter((t) => t !== sessionId);
        if (g.activeTab === sessionId) g.activeTab = g.tabs[0];
      }
    }
    delete this.tabGroupOf[sessionId]; // 単独で新ペインへ出たらグループから抜ける（INV-TG1）
    const fresh = newGroup([sessionId]);
    const dir: "row" | "col" = zone === "left" || zone === "right" ? "row" : "col";
    const newFirst = zone === "left" || zone === "top";
    const split: SplitNode = {
      type: "split",
      dir,
      ratio: 0.5,
      a: newFirst ? fresh : target,
      b: newFirst ? target : fresh
    };
    this.root = replace(this.root, groupId, split);
    this.focusedGroupId = fresh.id;
    this.pruneEmpty();
    this.normalizeTabGroups();
  },

  closeSession(sessionId: string): void {
    for (const g of this.groups()) {
      if (g.tabs.includes(sessionId)) {
        g.tabs = g.tabs.filter((t) => t !== sessionId);
        if (g.activeTab === sessionId) g.activeTab = g.tabs[0];
      }
    }
    // 対応表からも外す（閉じたタブの所属を残さない）
    delete this.tabSystem[sessionId];
    delete this.tabGroupOf[sessionId];
    this.pruneEmpty();
    // 残り 1 枚になったタブグループはここで解ける（requirement 4）
    this.normalizeTabGroups();
  },

  setRatio(splitFinder: (n: SplitNode) => boolean, ratio: number): void {
    const walk = (n: WsNode): void => {
      if (n.type === "split") {
        if (splitFinder(n)) n.ratio = Math.max(0.1, Math.min(0.9, ratio));
        walk(n.a);
        walk(n.b);
      }
    };
    walk(this.root);
  },

  /** 空グループを片付ける。全部空ならルートを単一空グループに */
  pruneEmpty(): void {
    const nonEmpty = this.groups().filter((g) => g.tabs.length > 0);
    if (nonEmpty.length === 0) {
      this.init();
      return;
    }
    let root = this.root;
    for (const g of this.groups()) {
      if (g.tabs.length === 0) root = removeGroup(root, g.id) ?? root;
    }
    this.root = root;
    if (!findGroup(this.root, this.focusedGroupId)) this.focusedGroupId = this.groups()[0]!.id;
    this.syncMaximized();
  }
});
