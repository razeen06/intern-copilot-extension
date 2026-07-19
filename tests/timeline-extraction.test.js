const test = require("node:test");
const assert = require("node:assert/strict");

const { extractHiringEndDate } = require("../timeline-extraction.js");

test("extracts a complete program start date", () => {
  assert.equal(
    extractHiringEndDate("The 2027 graduate program commences on 17 February 2027."),
    "2027-02-17"
  );
});

test("extracts an explicit end of the recruitment process", () => {
  assert.equal(
    extractHiringEndDate("Our recruitment process concludes 2026-11-30."),
    "2026-11-30"
  );
});

test("does not treat the application closing date as no-chance date", () => {
  assert.equal(
    extractHiringEndDate("Applications close 30/09/2026. Submit before the application deadline."),
    null
  );
});

test("rejects partial dates and unrelated dates", () => {
  assert.equal(extractHiringEndDate("The program begins in February 2027."), null);
  assert.equal(extractHiringEndDate("Page updated on 17 February 2027."), null);
});
