/**
 * UTF-8-safe line reader for a child process stdout stream.
 *
 * A multi-byte UTF-8 character can be split across two `data` chunks.
 * Decoding each chunk independently (`chunk.toString()`) replaces the split
 * character with U+FFFD replacement characters, which corrupts the event
 * JSON (message dedup signatures, stored text). This reader accumulates raw
 * bytes and only decodes complete lines — everything up to the last newline
 * — so a character is never decoded in a half state.
 */
export interface Utf8LineReader {
  /** Feed a raw chunk; complete lines are delivered to `onLine` in order. */
  push(chunk: Buffer): void;
  /** Deliver whatever remains after the last newline (end of stream). */
  flush(): void;
}

export function createUtf8LineReader(onLine: (line: string) => void): Utf8LineReader {
  let pending = Buffer.alloc(0);

  return {
    push(chunk: Buffer): void {
      pending = Buffer.concat([pending, chunk]);
      let start = 0;
      let index = pending.indexOf(0x0a);
      while (index !== -1) {
        let end = index;
        if (end > start && pending[end - 1] === 0x0d) end -= 1; // strip \r of \r\n
        onLine(pending.subarray(start, end).toString("utf8"));
        start = index + 1;
        index = pending.indexOf(0x0a, start);
      }
      pending = pending.subarray(start);
    },

    flush(): void {
      if (pending.length === 0) return;
      const rest = pending;
      pending = Buffer.alloc(0);
      onLine(rest.toString("utf8"));
    },
  };
}
