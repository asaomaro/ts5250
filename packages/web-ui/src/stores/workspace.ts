import { reactive } from "vue";

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

let gid = 0;
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
  /** システムごとに最後に見ていたタブ。切り替えて戻ったときの復帰先 */
  lastActiveBySystem: {} as Record<string, string>,
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
  /** SO/SI を {}表示するか（ACS の Ctrl+F 相当。全ペイン共通の表示設定） */
  showShiftMarks: false,
  /** 半角カナ表示（英小文字位置をカナ解釈。ACS の表示コード切替） */
  katakanaView: false,
  /** 画面テキストの URL/メールをリンク化（既定 ON） */
  linkify: true,

  init(): void {
    this.root = newGroup();
    this.focusedGroupId = (this.root as GroupNode).id;
    this.maximizedGroupId = undefined;
  },

  /** ペイン分割されているか（＝最大化ボタンを出す条件） */
  isSplit(): boolean {
    return this.root.type === "split";
  },

  /** 実際に描画するツリー。最大化中はそのグループだけ（分割ツリーは保持したまま） */
  displayRoot(): WsNode {
    const id = this.maximizedGroupId;
    if (id === undefined) return this.root;
    return findGroup(this.root, id) ?? this.root;
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
    if (systemRef !== undefined) {
      this.tabSystem[sessionId] = systemRef;
      this.lastActiveBySystem[systemRef] = sessionId;
    }
  },

  /**
   * 選択中システムに属するタブだけに絞る。
   *
   * **これは描画側の派生であって、`tabs` 配列は書き換えない**（design の判断）。
   * 配列から外して戻す形にすると、復元漏れが「閉じた」と区別できなくなる。
   * 実体を触らなければ、そもそも失われようがない。
   *
   * どのシステムにも紐づいていないタブ（対応表に無いもの）は常に見せる——
   * 記録漏れで見えなくなるより、余計に見えるほうが安全。
   */
  visibleTabs(g: GroupNode, systemRef: string | undefined): string[] {
    // 実配列を返さない。呼び出し側が結果を書き換えても group が壊れないようにする
    // （「隠す」が「閉じる」に化けないための不変条件を、返り値の側でも守る）
    if (systemRef === undefined) return [...g.tabs];
    return g.tabs.filter((t) => {
      const owner = this.tabSystem[t];
      return owner === undefined || owner === systemRef;
    });
  },

  /**
   * 切り替え後に選ぶべきタブ。**最後に見ていたものへ戻す**（先頭固定より復帰が自然）。
   * 見えるタブが無ければ undefined（ランチャーが出る）。
   */
  activeTabFor(g: GroupNode, systemRef: string | undefined): string | undefined {
    const visible = this.visibleTabs(g, systemRef);
    if (visible.length === 0) return undefined;
    if (g.activeTab !== undefined && visible.includes(g.activeTab)) return g.activeTab;
    const last = systemRef !== undefined ? this.lastActiveBySystem[systemRef] : undefined;
    if (last !== undefined && visible.includes(last)) return last;
    return visible[0];
  },

  /** タブの所属システムを記録する（セッション確立後など、後から分かる場合） */
  assignSystem(sessionId: string, systemRef: string): void {
    this.tabSystem[sessionId] = systemRef;
    this.lastActiveBySystem[systemRef] = sessionId;
  },

  setActiveTab(groupId: string, sessionId: string): void {
    const g = findGroup(this.root, groupId);
    if (g && g.tabs.includes(sessionId)) g.activeTab = sessionId;
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
    rest.splice(at, 0, sessionId);
    to.tabs = rest;
    to.activeTab = sessionId; // 落としたタブをアクティブに
    this.focusedGroupId = to.id;
    if (from !== to && from.tabs.length === 0) this.pruneEmpty();
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
    if (from.tabs.length === 0) this.pruneEmpty();
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
  },

  closeSession(sessionId: string): void {
    for (const g of this.groups()) {
      if (g.tabs.includes(sessionId)) {
        g.tabs = g.tabs.filter((t) => t !== sessionId);
        if (g.activeTab === sessionId) g.activeTab = g.tabs[0];
      }
    }
    // 対応表からも外す（閉じたタブの所属を残さない）
    const owner = this.tabSystem[sessionId];
    delete this.tabSystem[sessionId];
    if (owner !== undefined && this.lastActiveBySystem[owner] === sessionId) {
      delete this.lastActiveBySystem[owner];
    }
    this.pruneEmpty();
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
