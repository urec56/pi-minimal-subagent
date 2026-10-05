import assert from "node:assert/strict";
import test from "node:test";
import { createUtf8LineReader } from "./utf8-lines.ts";

test("complete lines are delivered as they arrive", () => {
  const lines = [];
  const reader = createUtf8LineReader((line) => lines.push(line));
  reader.push(Buffer.from('{"a":1}\n{"b":2}\n'));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("a line without trailing newline is held back until flush", () => {
  const lines = [];
  const reader = createUtf8LineReader((line) => lines.push(line));
  reader.push(Buffer.from('{"a":1}\n{"b":2}'));
  assert.deepEqual(lines, ['{"a":1}']);
  reader.flush();
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("a multi-byte character split across chunks is decoded intact", () => {
  const line = '{"text":"дневные бакеты"}';
  const full = Buffer.from(line + "\n", "utf8");
  // Split inside the first 2-byte Cyrillic character (д = D0 B4).
  const splitAt = full.indexOf(0xd0) + 1;
  const lines = [];
  const reader = createUtf8LineReader((l) => lines.push(l));
  reader.push(full.subarray(0, splitAt));
  reader.push(full.subarray(splitAt));
  assert.deepEqual(lines, [line]);
});

test("feeding one byte at a time never produces U+FFFD", () => {
  const line = '{"text":"→ дневные"}';
  const full = Buffer.from(line + "\n", "utf8");
  const lines = [];
  const reader = createUtf8LineReader((l) => lines.push(l));
  for (let i = 0; i < full.length; i++) reader.push(full.subarray(i, i + 1));
  assert.deepEqual(lines, [line]);
  assert.ok(!lines.some((l) => l.includes("\uFFFD")));
});

test("CRLF line endings are stripped", () => {
  const lines = [];
  const reader = createUtf8LineReader((line) => lines.push(line));
  reader.push(Buffer.from('{"a":1}\r\n{"b":2}\r\n'));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("multiple lines can arrive in one chunk and chunks can span lines", () => {
  const lines = [];
  const reader = createUtf8LineReader((line) => lines.push(line));
  reader.push(Buffer.from('{"a":1}\n{"b":2'));
  reader.push(Buffer.from('}\n{"c":3}\n'));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});
