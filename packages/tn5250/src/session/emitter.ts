/**
 * 最小の型付きイベントエミッタ（ピュア実装）。
 * node:events を使わないのは core のピュアロジック層規約のため（ブラウザ互換も保つ）。
 */
export class Emitter<E extends Record<string, unknown[]>> {
  private listeners = new Map<keyof E, Set<unknown>>();

  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return this;
  }

  off<K extends keyof E>(event: K, fn: (...args: E[K]) => void): this {
    this.listeners.get(event)?.delete(fn);
    return this;
  }

  protected emit<K extends keyof E>(event: K, ...args: E[K]): void {
    for (const fn of this.listeners.get(event) ?? []) {
      (fn as (...a: E[K]) => void)(...args);
    }
  }
}
