/**
 * Company logos by ticker. Tried in order; if every source fails the badge falls back to a monogram.
 * Base assets (ETH, USDG) use built-in marks, so they never depend on a third party.
 */
export function logoSources(symbol: string): string[] {
  const s = encodeURIComponent(symbol.toUpperCase());
  return [
    `https://financialmodelingprep.com/image-stock/${s}.png`,
    `https://assets.parqet.com/logos/symbol/${s}?format=png`,
  ];
}
