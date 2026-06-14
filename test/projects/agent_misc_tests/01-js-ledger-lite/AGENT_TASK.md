# Task: Fix ledger summary behavior

## Goal

Fix the ledger helpers in `src/ledger.js` so the tests pass while keeping the exported function names stable.

## Requirements

- `parseAmount(value)` should accept numbers and strings.
- String amounts may include `$`, commas, whitespace, a leading minus sign, or accounting parentheses such as `($42.10)`.
- Invalid amounts should throw a useful `TypeError`.
- `summarizeByCategory(transactions)` should ignore transactions whose `status` is `voided`.
- Categories should be normalized with trim + lowercase.
- Sums should be rounded to cents in a stable way.
- `topCategories(summary, limit)` should sort by absolute spend descending, then category name ascending.

## Validation

Run from this directory:

```powershell
npm test
```
