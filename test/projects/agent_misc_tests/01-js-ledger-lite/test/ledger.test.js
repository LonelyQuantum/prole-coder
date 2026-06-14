import assert from "node:assert/strict";
import test from "node:test";

import { parseAmount, summarizeByCategory, topCategories } from "../src/ledger.js";

test("parseAmount accepts common ledger formats", () => {
  assert.equal(parseAmount(12.5), 12.5);
  assert.equal(parseAmount(" $1,234.50 "), 1234.5);
  assert.equal(parseAmount("-$19.99"), -19.99);
  assert.equal(parseAmount("($42.10)"), -42.1);
});

test("parseAmount rejects invalid amounts", () => {
  assert.throws(() => parseAmount("not money"), TypeError);
  assert.throws(() => parseAmount(undefined), TypeError);
});

test("summarizeByCategory ignores voided transactions and normalizes categories", () => {
  const summary = summarizeByCategory([
    { amount: "$10.005", category: " Food ", status: "posted" },
    { amount: "5.005", category: "food", status: "posted" },
    { amount: "$999.00", category: "Food", status: "voided" },
    { amount: "($3.50)", category: "Transport", status: "posted" }
  ]);

  assert.deepEqual(summary, {
    food: 15.01,
    transport: -3.5
  });
});

test("topCategories sorts by absolute amount then category", () => {
  assert.deepEqual(
    topCategories({ books: -20, food: 20, rent: -900, travel: -20 }, 3),
    [
      { category: "rent", amount: -900 },
      { category: "books", amount: -20 },
      { category: "food", amount: 20 }
    ]
  );
});
