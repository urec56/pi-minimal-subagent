import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateContextWarning, validateContextWarning } from "./context-warning.ts";

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

test("valid config resolves relative message file against cwd and captures content", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "stop.md", "Wrap up your session now.");
  const result = validateContextWarning({ percent: 85, messageFile: "stop.md" }, dir);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.warning.percent, 85);
    assert.equal(result.warning.messageFile, path.join(dir, "stop.md"));
    assert.equal(result.warning.content, "Wrap up your session now.");
  }
});

test("absolute message file paths are used as-is", () => {
  const dir = makeTmpDir();
  const absolute = writeMessageFile(makeTmpDir(), "other-dir-msg.txt", "done");
  const result = validateContextWarning({ percent: 0.5, messageFile: absolute }, dir);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.warning.messageFile, absolute);
    assert.equal(result.warning.content, "done");
  }
});

test("uppercase .MD extension is accepted", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "STOP.MD", "stop please");
  const result = validateContextWarning({ percent: 100, messageFile: "./STOP.MD" }, dir);
  assert.equal(result.ok, true);
});

test("non-object config is rejected with what was actually given", () => {
  const errors = errorsOf(validateContextWarning("85", "/tmp"));
  assert.deepEqual(errors, ['contextWarning must be an object (got "85")']);

  const arrayErrors = errorsOf(validateContextWarning([1], "/tmp"));
  assert.match(arrayErrors[0], /must be an object/);
});

test("missing keys are reported", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "valid.md", "msg");
  assert.deepEqual(errorsOf(validateContextWarning({ messageFile: "valid.md" }, dir)), [
    "contextWarning.percent is required",
  ]);
  assert.deepEqual(errorsOf(validateContextWarning({ percent: 50 }, dir)), [
    "contextWarning.messageFile is required",
  ]);
});

test("string percent is rejected with the actual value shown", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "valid.md", "msg");
  const errors = errorsOf(validateContextWarning({ percent: "85", messageFile: "valid.md" }, dir));
  assert.deepEqual(errors, ["contextWarning.percent must be a finite number between 0 and 100 (got \"85\")"]);
});

test("non-finite, negative and out-of-range percents are rejected", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "x.md", "msg");
  assert.deepEqual(errorsOf(validateContextWarning({ percent: Infinity, messageFile: "x.md" }, dir)), [
    "contextWarning.percent must be a finite number between 0 and 100 (got null)",
  ]);
  assert.deepEqual(errorsOf(validateContextWarning({ percent: -5, messageFile: "x.md" }, dir)), [
    "contextWarning.percent must be >= 0 (got -5)",
  ]);
  assert.deepEqual(errorsOf(validateContextWarning({ percent: 150, messageFile: "x.md" }, dir)), [
    "contextWarning.percent must be <= 100 (got 150)",
  ]);
});

test("integer percents and the 0/100 boundaries are valid", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "x.md", "msg");
  assert.equal(validateContextWarning({ percent: 85, messageFile: "x.md" }, dir).ok, true);
  assert.equal(validateContextWarning({ percent: 0, messageFile: "x.md" }, dir).ok, true);
  assert.equal(validateContextWarning({ percent: 100, messageFile: "x.md" }, dir).ok, true);
});

test("wrong extension is rejected", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "notes.json", "{}");
  const errors = errorsOf(validateContextWarning({ percent: 50, messageFile: "notes.json" }, dir));
  assert.deepEqual(errors, ['contextWarning.messageFile must end in .md or .txt (got "notes.json")']);
});

test("missing file is reported with the resolved path", () => {
  const dir = makeTmpDir();
  const errors = errorsOf(validateContextWarning({ percent: 50, messageFile: "nope.md" }, dir));
  assert.deepEqual(errors, [`contextWarning.messageFile does not exist: ${path.join(dir, "nope.md")}`]);
});

test("a directory ending in .md is rejected as not a regular file", () => {
  const dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, "dir.md"));
  const errors = errorsOf(validateContextWarning({ percent: 50, messageFile: "dir.md" }, dir));
  assert.deepEqual(errors, [`contextWarning.messageFile is not a regular file: ${path.join(dir, "dir.md")}`]);
});

test("empty and whitespace-only files are rejected", () => {
  const dir = makeTmpDir();
  writeMessageFile(dir, "empty.md", "");
  assert.deepEqual(errorsOf(validateContextWarning({ percent: 50, messageFile: "empty.md" }, dir)), [
    `contextWarning.messageFile is empty: ${path.join(dir, "empty.md")}`,
  ]);

  writeMessageFile(dir, "blank.txt", "   \n\t\n");
  assert.deepEqual(errorsOf(validateContextWarning({ percent: 50, messageFile: "blank.txt" }, dir)), [
    `contextWarning.messageFile is empty: ${path.join(dir, "blank.txt")}`,
  ]);
});

test("all found problems are collected into one list", () => {
  const dir = makeTmpDir();
  const errors = errorsOf(validateContextWarning({ percent: -1, messageFile: "missing.md" }, dir));
  assert.deepEqual(errors, [
    "contextWarning.percent must be >= 0 (got -1)",
    `contextWarning.messageFile does not exist: ${path.join(dir, "missing.md")}`,
  ]);
});

test("evaluateContextWarning fires at and above the threshold with real usage data", () => {
  assert.deepEqual(evaluateContextWarning({ percent: 85 }, 1000, 850), { reached: true, percent: 85 });
  assert.equal(evaluateContextWarning({ percent: 85 }, 1000, 999).reached, true);
});

test("evaluateContextWarning does not fire below the threshold", () => {
  assert.deepEqual(evaluateContextWarning({ percent: 85 }, 1000, 849), { reached: false });
});

test("evaluateContextWarning needs positive tokens and a usable window", () => {
  assert.deepEqual(evaluateContextWarning({ percent: 0.1 }, undefined, 100), { reached: false });
  assert.deepEqual(evaluateContextWarning({ percent: 0.1 }, 1000, 0), { reached: false });
  assert.deepEqual(evaluateContextWarning({ percent: 0.1 }, 1000, undefined), { reached: false });
  assert.deepEqual(evaluateContextWarning({ percent: 0.1 }, 0, 100), { reached: false });
});

test("threshold 0 fires as soon as any usage data exists", () => {
  assert.equal(evaluateContextWarning({ percent: 0 }, 1000, 1).reached, true);
});
