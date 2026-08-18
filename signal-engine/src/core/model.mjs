export const StockStatus = Object.freeze({
  IN_STOCK: "in_stock",
  LOW_STOCK: "low_stock",
  OUT_OF_STOCK: "out_of_stock",
  PREORDER: "preorder",
  COMING_SOON: "coming_soon",
  UNKNOWN: "unknown",
});

export const SignalState = Object.freeze({
  WHISPER: "whisper",
  MANIFESTED: "manifested",
  VANISHED: "vanished",
  ECHO: "echo",
});

export function isPurchasable(status) {
  return status === StockStatus.IN_STOCK || status === StockStatus.LOW_STOCK;
}
