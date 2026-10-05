import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { selectContextWarning, validateContextWarning } from "./context-warning.ts";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ctxwarn-test-"));
}

function writeMessageFile(dir, name, content) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function errorsOf(result) {
  assert.equal(result.ok, false, `expected validation failure, got: ${JSON.stringify(result)}`);
  return result.errors;
}

test("valid list resolves relative message files against cwd and captures content", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "warn.md", "Start wrapping up.");
  writeMessageFile(dir, "stop.md", "Wrap up your session now.");
  const result = validateContextWarning(
    [
      { percent: 70, messageFile: "warn.md" },
      { percent: 85, messageFile: "stop.md" },
    ],
    dir,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.warnings.length, 2);
    assert.equal(result.warnings[0].percent, 70);
    assert.equal(result.warnings[0].messageFile, path.join(dir, "warn.md"));
    assert.equal(result.warnings[0].content, "Start wrapping up.");
    assert.equal(result.warnings[1].percent, 85);
    assert.equal(result.warnings[1].messageFile, path.join(dir, "stop.md"));
    assert.equal(result.warnings[1].content, "Wrap up your session now.");
  }
});

test("unsorted input comes back sorted by percent", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "a.md", "a");
  writeMessageFile(dir, "b.md", "b");
  writeMessageFile(dir, "c.md", "c");
  const result = validateContextWarning(
    [
      { percent: 90, messageFile: "c.md" },
      { percent: 50, messageFile: "a.md" },
      { percent: 70, messageFile: "b.md" },
    ],
    dir,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.warnings.map((warning) => warning.percent), [50, 70, 90]);
  }
});

test("null, undefined and an empty list are silently off", () => {
  for (const raw of [undefined, null, []]) {
    const result = validateContextWarning(raw, "/tmp");
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.warnings, []);
  }
});

test("non-array config is rejected with what was actually given", () => {
  assert.deepEqual(errorsOf(validateContextWarning("85", "/tmp")), [
    'contextWarning must be an array of { percent, messageFile } entries (got "85")',
  ]);
  assert.deepEqual(errorsOf(validateContextWarning({ percent: 85, messageFile: "x.md" }, "/tmp")), [
    'contextWarning must be an array of { percent, messageFile } entries (got {"percent":85,"messageFile":"x.md"})',
  ]);
});

test("per-entry errors are reported with the entry index", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "valid.md", "msg");
  const errors = errorsOf(
    validateContextWarning(
      [
        { percent: "85", messageFile: "valid.md" },
        { messageFile: "valid.md" },
        { percent: 50 },
        "not-an-object",
      ],
      dir,
    ),
  );
  assert.deepEqual(errors, [
    'contextWarning[0].percent must be a finite number between 0 and 100 (got "85")',
    "contextWarning[1].percent is required",
    "contextWarning[2].messageFile is required",
    'contextWarning[3] must be an object (got "not-an-object")',
  ]);
});

test("duplicate percent is rejected with the entry indexes", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "a.md", "a");
  writeMessageFile(dir, "b.md", "b");
  writeMessageFile(dir, "c.md", "c");
  const errors = errorsOf(
    validateContextWarning(
      [
        { percent: 85, messageFile: "a.md" },
        { percent: 70, messageFile: "b.md" },
        { percent: 85, messageFile: "c.md" },
      ],
      dir,
    ),
  );
  assert.deepEqual(errors, ["contextWarning.percent 85 is specified more than once (entries 0, 2)"]);
});

test("the same messageFile is allowed in different entries", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "same.md", "same");
  const result = validateContextWarning(
    [
      { percent: 70, messageFile: "same.md" },
      { percent: 85, messageFile: "same.md" },
    ],
    dir,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.warnings.length, 2);
});

test("absolute message file paths are used as-is", () => {
  const dir = makeTmpDir();
  const absolute = writeMessageFile(makeTmpDir(), "other-dir-msg.txt", "done");
  const result = validateContextWarning([{ percent: 0.5, messageFile: absolute }], dir);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.warnings[0].messageFile, absolute);
    assert.equal(result.warnings[0].content, "done");
  }
});

test("uppercase .MD extension is accepted", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "STOP.MD", "stop please");
  const result = validateContextWarning([{ percent: 100, messageFile: "./STOP.MD" }], dir);
  assert.equal(result.ok, true);
});

test("non-finite, negative and out-of-range percents are rejected", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "x.md", "msg");
  assert.deepEqual(errorsOf(validateContextWarning([{ percent: Infinity, messageFile: "x.md" }], dir)), [
    "contextWarning[0].percent must be a finite number between 0 and 100 (got null)",
  ]);
  assert.deepEqual(errorsOf(validateContextWarning([{ percent: -5, messageFile: "x.md" }], dir)), [
    "contextWarning[0].percent must be >= 0 (got -5)",
  ]);
  assert.deepEqual(errorsOf(validateContextWarning([{ percent: 150, messageFile: "x.md" }], dir)), [
    "contextWarning[0].percent must be <= 100 (got 150)",
  ]);
});

test("integer percents and the 0/100 boundaries are valid", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "x.md", "msg");
  assert.equal(validateContextWarning([{ percent: 85, messageFile: "x.md" }], dir).ok, true);
  assert.equal(validateContextWarning([{ percent: 0, messageFile: "x.md" }], dir).ok, true);
  assert.equal(validateContextWarning([{ percent: 100, messageFile: "x.md" }], dir).ok, true);
});

test("wrong extension is rejected", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "notes.json", "{}");
  const errors = errorsOf(validateContextWarning([{ percent: 50, messageFile: "notes.json" }], dir));
  assert.deepEqual(errors, ['contextWarning[0].messageFile must end in .md or .txt (got "notes.json")']);
});

test("missing file is reported with the resolved path", () => {
  const dir = makeTmpDir();
  const errors = errorsOf(validateContextWarning([{ percent: 50, messageFile: "nope.md" }], dir));
  assert.deepEqual(errors, [`contextWarning[0].messageFile does not exist: ${path.join(dir, "nope.md")}`]);
});

test("a directory ending in .md is rejected as not a regular file", () => {
  const dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, "dir.md"));
  const errors = errorsOf(validateContextWarning([{ percent: 50, messageFile: "dir.md" }], dir));
  assert.deepEqual(errors, [`contextWarning[0].messageFile is not a regular file: ${path.join(dir, "dir.md")}`]);
});

test("empty and whitespace-only files are rejected", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "empty.md", "");
  assert.deepEqual(errorsOf(validateContextWarning([{ percent: 50, messageFile: "empty.md" }], dir)), [
    `contextWarning[0].messageFile is empty: ${path.join(dir, "empty.md")}`,
  ]);

  writeMessageFile(dir, "blank.txt", "   \n\t\n");
  assert.deepEqual(errorsOf(validateContextWarning([{ percent: 50, messageFile: "blank.txt" }], dir)), [
    `contextWarning[0].messageFile is empty: ${path.join(dir, "blank.txt")}`,
  ]);
});

test("all found problems are collected into one list", () => {
  const dir = makeTmpDir();
  const errors = errorsOf(
    validateContextWarning(
      [
        { percent: -1, messageFile: "missing.md" },
        { percent: 50, messageFile: "notes.json" },
      ],
      dir,
    ),
  );
  assert.deepEqual(errors, [
    "contextWarning[0].percent must be >= 0 (got -1)",
    `contextWarning[0].messageFile does not exist: ${path.join(dir, "missing.md")}`,
    'contextWarning[1].messageFile must end in .md or .txt (got "notes.json")',
  ]);
});

test("selectContextWarning picks the highest reached threshold", () => {
  const warnings = [
    { percent: 70, messageFile: "a", content: "a" },
    { percent: 85, messageFile: "b", content: "b" },
  ];
  // Jumped over 70 in one update: only the highest reached threshold fires.
  assert.deepEqual(selectContextWarning(warnings, 0, 1000, 900), { index: 1, percent: 90 });
  assert.deepEqual(selectContextWarning(warnings, 0, 1000, 850), { index: 1, percent: 85 });
  assert.deepEqual(selectContextWarning(warnings, 0, 1000, 750), { index: 0, percent: 75 });
});

test("selectContextWarning respects nextIndex (fired and skipped are never redelivered)", () => {
  const warnings = [
    { percent: 70, messageFile: "a", content: "a" },
    { percent: 85, messageFile: "b", content: "b" },
  ];
  // 70 was fired earlier; a later 90% update delivers 85, not 70 again.
  assert.deepEqual(selectContextWarning(warnings, 1, 1000, 900), { index: 1, percent: 90 });
  assert.equal(selectContextWarning(warnings, 1, 1000, 800), undefined);
  // Both consumed: nothing left to deliver.
  assert.equal(selectContextWarning(warnings, 2, 1000, 999), undefined);
});

test("selectContextWarning needs positive tokens and a usable window", () => {
  const warnings = [{ percent: 0.1, messageFile: "a", content: "a" }];
  assert.equal(selectContextWarning(warnings, 0, undefined, 100), undefined);
  assert.equal(selectContextWarning(warnings, 0, 1000, 0), undefined);
  assert.equal(selectContextWarning(warnings, 0, 1000, undefined), undefined);
  assert.equal(selectContextWarning(warnings, 0, 0, 100), undefined);
});

test("threshold 0 fires as soon as any usage data exists", () => {
  const warnings = [{ percent: 0, messageFile: "a", content: "a" }];
  assert.deepEqual(selectContextWarning(warnings, 0, 1000, 1), { index: 0, percent: 0.1 });
});
