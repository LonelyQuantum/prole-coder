export function parseAmount(value) {
  if (typeof value === "number") {
    return value;
  }

  const cleaned = String(value).replace("$", "").trim();
  return Number(cleaned);
}

export function summarizeByCategory(transactions) {
  const summary = new Map();

  for (const transaction of transactions) {
    const category = transaction.category.trim();
    const current = summary.get(category) ?? 0;
    summary.set(category, current + parseAmount(transaction.amount));
  }

  return Object.fromEntries(summary.entries());
}

export function topCategories(summary, limit = 3) {
  return Object.entries(summary)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([category, amount]) => ({ category, amount }));
}
