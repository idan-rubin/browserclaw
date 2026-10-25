interface CursorRange {
  start: number;
  end: number;
}

function mergeCursorRanges(ranges: CursorRange[]): CursorRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: CursorRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end + 1) {
      if (range.end > last.end) last.end = range.end;
      continue;
    }
    merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

function literalCursorRanges(url: string, literal: string, ranges: CursorRange[]): CursorRange[] {
  const next: CursorRange[] = [];
  const width = literal.length;
  for (const range of ranges) {
    let run: CursorRange | undefined;
    const last = Math.min(range.end, url.length - width);
    for (let pos = range.start; pos <= last; pos += 1) {
      if (!url.startsWith(literal, pos)) continue;
      const at = pos + width;
      if (run && at <= run.end + 1) run.end = at;
      else {
        run = { start: at, end: at };
        next.push(run);
      }
    }
  }
  return mergeCursorRanges(next);
}

function globCursorRanges(url: string, ranges: CursorRange[]): CursorRange[] {
  const first = ranges.at(0);
  return first ? [{ start: first.start, end: url.length }] : [];
}

/** Match without backtracking; Browserclaw's single `*` also spans `/` (KD7). */
export function matchUrlPattern(pattern: string, url: string): boolean {
  if (!pattern || !url) return false;
  if (pattern === url) return true;
  if (!pattern.includes('*')) return url.includes(pattern);
  const tokens = pattern.match(/\*\*|\*|[^*]+/g) ?? [];
  let ranges: CursorRange[] = [{ start: 0, end: 0 }];
  for (const token of tokens) {
    ranges = token === '*' || token === '**' ? globCursorRanges(url, ranges) : literalCursorRanges(url, token, ranges);
    if (ranges.length === 0) return false;
  }
  return ranges.some((range) => range.start <= url.length && url.length <= range.end);
}
