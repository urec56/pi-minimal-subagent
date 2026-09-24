import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePiSpawn } from "./runner.ts";

const SAVED_ARGV1 = process.argv[1];
const SAVED_PATH = process.env.PATH;

function makeFakePackage(pkgDir, name) {
  fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name, version: "0.0.0" }),
  );
}

function makeFakePiOnPath() {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spawn-test-"));
  const fakePi = path.join(binDir, "pi");
  fs.writeFileSync(fakePi, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { binDir, fakePi };
}

function withArgv1(argv1, fn) {
  process.argv[1] = argv1;
  try {
    return fn();
  } finally {
    process.argv[1] = SAVED_ARGV1;
  }
}

test("argv[1] inside a pi-coding-agent package reuses node + that entry file", () => {
  const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-pi-pkg-"));
  try {
    makeFakePackage(pkgDir, "@fake/pi-coding-agent");
    const cliEntry = path.join(pkgDir, "dist", "cli.js");
    fs.writeFileSync(cliEntry, "// fake pi cli entry\n");

    withArgv1(cliEntry, () => {
      const spawnInfo = resolvePiSpawn();
      assert.equal(spawnInfo.command, process.execPath);
      assert.deepEqual(spawnInfo.prefixArgs, [cliEntry]);
    });
  } finally {
    fs.rmSync(pkgDir, { recursive: true, force: true });
  }
});

test("argv[1] outside any pi package falls back to pi on PATH", () => {
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "not-pi-"));
  const fake = makeFakePiOnPath();
  try {
    // A package that is NOT the Pi coding agent must not trigger the fast path.
    makeFakePackage(scriptDir, "@user/some-other-tool");
    const script = path.join(scriptDir, "index.js");
    fs.writeFileSync(script, "// arbitrary script\n");

    process.env.PATH = fake.binDir;
    withArgv1(script, () => {
      const spawnInfo = resolvePiSpawn();
      assert.equal(spawnInfo.command, fake.fakePi);
      assert.deepEqual(spawnInfo.prefixArgs, []);
    });
  } finally {
    process.env.PATH = SAVED_PATH;
    fs.rmSync(scriptDir, { recursive: true, force: true });
    fs.rmSync(fake.binDir, { recursive: true, force: true });
  }
});

test("no pi package and no pi on PATH throws instead of guessing", () => {
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "not-pi-2-"));
  try {
    makeFakePackage(scriptDir, "@user/some-other-tool");
    const script = path.join(scriptDir, "index.js");
    fs.writeFileSync(script, "// arbitrary script\n");

    process.env.PATH = "/definitely/not/here";
    withArgv1(script, () => {
      assert.throws(
        () => resolvePiSpawn(),
        /Unable to locate the Pi CLI/,
      );
    });
  } finally {
    process.env.PATH = SAVED_PATH;
    fs.rmSync(scriptDir, { recursive: true, force: true });
  }
});
