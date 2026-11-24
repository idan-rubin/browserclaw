/** Truncate to `maxLength` UTF-16 code units without splitting a surrogate pair. */
export function truncateUtf16Safe(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let end = Math.max(0, Math.trunc(maxLength));
  const lastCodeUnit = value.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  return value.slice(0, end);
}
