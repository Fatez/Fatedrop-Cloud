import { StockStatus } from "./model.mjs";
import { normalizeWhitespace } from "./normalize.mjs";

export function classifyStockStatus(text = "") {
  const value = normalizeWhitespace(text).toLowerCase();
  if (!value) return { status: StockStatus.UNKNOWN, confidence: 0.2, evidence: "No stock wording found" };

  const low = value.match(/only\s+(\d+)\s+(?:left|remaining)/i);
  if (low) return { status: StockStatus.LOW_STOCK, confidence: 0.99, quantity: Number(low[1]), evidence: low[0] };

  const rules = [
    [StockStatus.OUT_OF_STOCK, 0.99, /sold out|out of stock|currently unavailable|unavailable online|temporarily unavailable|schema\.org\/outofstock/],
    [StockStatus.PREORDER, 0.96, /pre[- ]?order|preorder/],
    [StockStatus.COMING_SOON, 0.92, /coming soon|notify me|release date|estimated delayed/],
    [StockStatus.IN_STOCK, 0.98, /add to basket|add to cart|in stock|available for delivery|buy now|schema\.org\/instock/],
  ];
  for (const [status, confidence, regex] of rules) {
    const match = value.match(regex);
    if (match) return { status, confidence, evidence: match[0] };
  }
  return { status: StockStatus.UNKNOWN, confidence: 0.35, evidence: "No definitive stock phrase" };
}
