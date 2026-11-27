import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_FORMAT,
  enabledFormats,
  formatSchema,
  getFormatProfile,
  isEnabledFormat,
} from "../src/lib/formats.ts";

test("DEFAULT_FORMAT is short_film", () => {
  assert.equal(DEFAULT_FORMAT, "short_film");
});

test("getFormatProfile returns an enabled profile for short_film", () => {
  const profile = getFormatProfile("short_film");
  assert.equal(profile.id, "short_film");
  assert.equal(profile.enabled, true);
});

test("isEnabledFormat only accepts enabled, registered formats", () => {
  assert.equal(isEnabledFormat("short_film"), true);
  assert.equal(isEnabledFormat("feature_film"), false);
  assert.equal(isEnabledFormat("not_a_format"), false);
});

test("enabledFormats lists only short_film", () => {
  assert.deepEqual(enabledFormats(), ["short_film"]);
});

test("formatSchema accepts short_film", () => {
  assert.equal(formatSchema.safeParse("short_film").success, true);
});

test("formatSchema rejects a disabled format with the not-available message", () => {
  const result = formatSchema.safeParse("feature_film");
  assert.equal(result.success, false);
  assert.equal(result.error?.issues[0]?.message, "This filmmaking format isn’t available yet.");
});

test("formatSchema rejects an unknown format", () => {
  assert.equal(formatSchema.safeParse("nope").success, false);
});
