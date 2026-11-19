// Tolerant JSONL reader: a missing file is empty, an unparsable line is skipped, and a last line without a
// newline (still being written) is left for the next read, so endByte only covers complete lines.
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';

export function readJsonl(path, { fromByte = 0 } = {}) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { records: [], endByte: fromByte > 0 ? fromByte : 0 };
  }
  try {
    const size = fstatSync(fd).size;
    // A file that shrank (rotated or rewritten) is read again from the start.
    const start = fromByte > size ? 0 : fromByte;
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    const lastNl = buf.subarray(0, got).lastIndexOf(0x0a);
    if (lastNl < 0) return { records: [], endByte: start };
    const records = [];
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { records.push(JSON.parse(t)); } catch { /* skip a broken line */ }
    }
    return { records, endByte: start + lastNl + 1 };
  } catch {
    return { records: [], endByte: fromByte };
  } finally {
    closeSync(fd);
  }
}
