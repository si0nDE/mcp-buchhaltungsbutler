export interface TtlCache<T> {
  get(force?: boolean): Promise<T>;
  invalidate(): void;
}

export function createTtlCache<T>(ttlMs: number, fetcher: () => Promise<T>): TtlCache<T> {
  let cached: { value: T; at: number } | undefined;

  return {
    async get(force = false) {
      if (!force && cached && Date.now() - cached.at < ttlMs) {
        return cached.value;
      }
      const value = await fetcher();
      cached = { value, at: Date.now() };
      return value;
    },
    invalidate() {
      cached = undefined;
    },
  };
}
