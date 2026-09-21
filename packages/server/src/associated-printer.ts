/**
 * **関連付けたプリンターセッションと表示の連動**（`20260921-associated-printer-session`）。
 *
 * ACS `AssociatedPrinterSession5250` は、表示が切れたら（ほかに同じ装置名へ関連付けた表示が繋がっていなければ）プリンターを止め、
 * 繋がったら起こし、表示を閉じたときに指定があれば（ほかに関連付けた表示が無ければ）プリンターも閉じる（`CommEvent` / `sessionLabelEvent`）。
 * ここは**その判断だけ**を純関数にする——`SessionManager` は表示・プリンターの実体を持っていて、実行はそちらがする。
 *
 * **常駐のプリンター（サービス ✅）は止めも閉じもしない**（decisions D2）。ACS に常駐という概念は無く、ほかの利用者や自動出力が
 * 頼る待ち受けを 1 つの表示の都合で止めない。
 */
export interface AssociatedDisplay {
  /** その表示が関連付けているプリンターの id（無ければ関連付けなし） */
  printerId: string | undefined;
  /** 表示がいま繋がっているか（繋ぎ直し中・閉じ済みは false） */
  connected: boolean;
}

export interface AssociatedPrinterState {
  resident: boolean;
  /** プリンターがいま待ち受けているか（`listening` / `reconnecting`） */
  running: boolean;
}

/**
 * **ほかに同じプリンターへ関連付けた、繋がっている表示があるか**（ACS `isOtherDisplayAssociated`）。
 * `others` は**自分を除いた**表示の一覧
 */
export function otherDisplayAssociated(printerId: string, others: readonly AssociatedDisplay[]): boolean {
  return others.some((d) => d.printerId === printerId && d.connected);
}

/**
 * 表示が切れた（繋ぎ直しに入った・ホストが終わった・閉じた）ときの、プリンターへの処置。
 * ほかの表示が使っていれば触らない。常駐は触らない。止まっているものも触らない
 */
export function onDisplayLost(p: AssociatedPrinterState, othersUse: boolean): "stop" | "none" {
  if (p.resident || othersUse || !p.running) return "none";
  return "stop";
}

/** 表示が繋がった（繋ぎ直せた）ときの、プリンターへの処置。止まっていれば起こす（常駐は止めないので起こす必要も無いが、止まっていれば起こしてよい） */
export function onDisplayConnected(p: AssociatedPrinterState): "start" | "none" {
  return p.running ? "none" : "start";
}

/** 表示を閉じたとき、プリンターごと閉じるか。指定があり、ほかに使う表示が無く、常駐でないときだけ */
export function shouldClosePrinter(p: AssociatedPrinterState, closeWithLast: boolean, othersUse: boolean): boolean {
  return closeWithLast && !othersUse && !p.resident;
}
