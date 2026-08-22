/**
 * 最小のイベント発火。
 *
 * 外部依存を持ち込まないため自前で持つ（`@ts5250/tn5250` / `@ts5250/tn3270` の同名クラスと同型。
 * 20 行の型定義のために依存を 1 本増やす方が高くつく）。
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
