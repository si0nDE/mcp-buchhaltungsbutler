export function trimList<T extends Record<string, unknown>>(
  records: readonly T[],
  fields: readonly string[],
  full: boolean
): Array<Partial<T>> {
  if (full) {
    return records.map((record) => ({ ...record }));
  }
  return records.map((record) => {
    const out: Partial<T> = {};
    for (const field of fields) {
      if (field in record) {
        out[field as keyof T] = record[field as keyof T];
      }
    }
    return out;
  });
}
