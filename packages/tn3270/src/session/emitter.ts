/**
 * 最小のイベント発火。
 *
 * 外部依存を持ち込まないため自前で持つ（`@ts5250/tn5250` の同名クラスと同型・
 * decisions D2 と同じ「まず複製する」判断）。
 */
export class Emitter<M extends Record<string, unknown[]>> {
  private handlers = new Map<keyof M, Set<(...args: never[]) => void>>();

  on<K extends keyof M>(event: K, fn: (...args: M[K]) => void): void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(fn as unknown as (...args: never[]) => void);
    this.handlers.set(event, set);
  }

  emit<K extends keyof M>(event: K, ...args: M[K]): void {
    for (const fn of this.handlers.get(event) ?? []) {
      (fn as unknown as (...a: M[K]) => void)(...args);
    }
  }
}
