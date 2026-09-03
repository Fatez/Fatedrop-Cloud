function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function currency(value) {
  const code = text(value).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new TypeError('currencyCode must be a 3-letter currency code');
  return code;
}

function money(value, field) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${field} must be a non-negative finite number`);
  return number;
}

function roundMoney(value) {
  return Number(value.toFixed(2));
}

function roundPercent(value) {
  return Number(value.toFixed(2));
}

export function computeFateValueMovement({
  currentValue,
  baselineValue,
  currencyCode,
  baselineCurrencyCode = currencyCode,
  currentAsOf = null,
  baselineAsOf = null,
} = {}) {
  const currentCurrency = currency(currencyCode);
  const baselineCurrency = currency(baselineCurrencyCode);
  if (currentCurrency !== baselineCurrency) {
    return Object.freeze({
      status: 'unavailable',
      reason: 'currency_mismatch',
      currencyCode: currentCurrency,
      amountChange: null,
      percentChange: null,
      currentValue: null,
      baselineValue: null,
      currentAsOf,
      baselineAsOf,
    });
  }

  const current = money(currentValue, 'currentValue');
  const baseline = money(baselineValue, 'baselineValue');
  if (current == null || baseline == null) {
    return Object.freeze({
      status: 'unavailable',
      reason: 'complete_value_unavailable',
      currencyCode: currentCurrency,
      amountChange: null,
      percentChange: null,
      currentValue: current,
      baselineValue: baseline,
      currentAsOf,
      baselineAsOf,
    });
  }

  const amountChange = current - baseline;
  if (baseline === 0) {
    return Object.freeze({
      status: 'partial',
      reason: 'baseline_zero',
      currencyCode: currentCurrency,
      amountChange: roundMoney(amountChange),
      percentChange: null,
      currentValue: roundMoney(current),
      baselineValue: 0,
      currentAsOf,
      baselineAsOf,
    });
  }

  return Object.freeze({
    status: 'available',
    reason: null,
    currencyCode: currentCurrency,
    amountChange: roundMoney(amountChange),
    percentChange: roundPercent((amountChange / baseline) * 100),
    currentValue: roundMoney(current),
    baselineValue: roundMoney(baseline),
    currentAsOf,
    baselineAsOf,
  });
}
