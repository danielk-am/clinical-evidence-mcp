import assert from "node:assert/strict";
import test from "node:test";
import { InputError } from "../errors.js";
import { assertDeidentified, truncateText } from "../privacy.js";

test("normalises deidentified search text", () => {
  assert.equal(assertDeidentified("  heart   failure therapy  "), "heart failure therapy");
});

test("rejects obvious patient identifiers", () => {
  assert.throws(() => assertDeidentified("patient email jane@example.com"), InputError);
  assert.throws(() => assertDeidentified("MRN: 123456 diabetes"), InputError);
  assert.throws(() => assertDeidentified("DOB: 1970-01-01 hypertension"), InputError);
});

test("truncates and cleans upstream text", () => {
  assert.equal(truncateText(" a\n b ", 10), "a b");
  assert.equal(truncateText("123456", 5), "1234…");
  assert.equal(truncateText(undefined), null);
});
