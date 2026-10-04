// $FILL trades on the Pons launchpad, whose token pages are /launchpad/<address>. NEXT_PUBLIC_FILL_TRADE_URL overrides.
export const tradeUrl = (token?: string) =>
  process.env.NEXT_PUBLIC_FILL_TRADE_URL || `https://www.ponsfamily.com/launchpad${token ? `/${token}` : ""}`;

/** Internal routes. The header links with a trailing slash, so these do too. */
export const routes = {
  vaults: "/vaults/",
  vault: (ticker: string) => `/vaults/${ticker}/`,
  borrow: "/borrow/",
  portfolio: "/portfolio/",
};
