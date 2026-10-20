const BIGINT_MAX = 9223372036854775807n;

/** A row id: a positive bigint as Postgres keeps it. Anything else is no row, never a query error. */
export function isId(value: string): boolean {
  return /^\d{1,19}$/.test(value) && BigInt(value) <= BIGINT_MAX;
}
