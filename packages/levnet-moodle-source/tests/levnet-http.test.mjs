import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import {
  byteLimitTransform,
  sanitizeFileName,
} from "../scripts/lib/levnet/http.mjs";

test("download stream enforces the byte limit without buffering the file", async () => {
  const limiter = byteLimitTransform(4);
  await assert.rejects(
    () => pipeline(
      Readable.from([Buffer.from("abc"), Buffer.from("de")]),
      limiter,
      new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    ),
    /exceeds the 4-byte limit/,
  );
  assert.equal(limiter.bytesRead(), 5);
});

test("download filenames cannot escape the selected directory", () => {
  assert.equal(sanitizeFileName("../../secret.pdf"), "secret.pdf");
  const windowsStyleAttack = sanitizeFileName("..\\..\\evil:name?.pdf");
  assert.match(windowsStyleAttack, /evil_name_\.pdf$/);
  assert.doesNotMatch(windowsStyleAttack, /[\\/:?*]/);
  assert.equal(sanitizeFileName("..."), "levnet-download");
});
