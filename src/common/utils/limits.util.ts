/**
 * Upper bounds that match the database columns, so oversized input is a 400
 * with a clear message instead of a database overflow (500).
 */

/** Money columns are Decimal(12, 2): at most 10 digits before the point. */
export const MAX_MONEY = 9_999_999_999;

/** Stock/quantity columns are 32-bit Int; one billion is far beyond any real stock. */
export const MAX_QUANTITY = 1_000_000_000;
