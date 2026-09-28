/**
 * src/indexer/precision.ts
 *
 * Exact fixed-point arithmetic helpers for on-chain token amounts and fees.
 * Prevents precision loss from JavaScript `Number` (IEEE 754 float) which cannot
 * represent 128-bit integers or >53 bits of precision.
 */

/**
 * Parses a decimal string (or number/stringable) into a BigInt scaled by `decimals` places.
 * E.g., parseDecimalToBigInt("10.1234567", 7) -> 101234567n.
 */
export function parseDecimalToBigInt(
  val: string | number | { toString(): string } | null | undefined,
  decimals = 7,
): bigint {
  if (val === null || val === undefined) return 0n;
  const str = String(val).trim();
  if (!str || str === '0') return 0n;

  const isNegative = str.startsWith('-');
  const clean = isNegative ? str.slice(1) : str;
  const [whole = '0', fraction = ''] = clean.split('.');

  const sanitizedWhole = whole.replace(/\D/g, '') || '0';
  const sanitizedFraction = fraction.replace(/\D/g, '');
  const paddedFraction = sanitizedFraction.padEnd(decimals, '0').slice(0, decimals);

  const combined = sanitizedWhole + paddedFraction;
  try {
    const bi = BigInt(combined);
    return isNegative ? -bi : bi;
  } catch {
    return 0n;
  }
}

/**
 * Formats a scaled BigInt back to a decimal string with up to `decimals` places.
 * E.g., formatBigIntToDecimal(101234567n, 7) -> "10.1234567".
 */
export function formatBigIntToDecimal(val: bigint, decimals = 7): string {
  const isNegative = val < 0n;
  const abs = isNegative ? -val : val;
  const factor = 10n ** BigInt(decimals);

  const whole = abs / factor;
  const fraction = abs % factor;

  if (fraction === 0n) {
    return `${isNegative ? '-' : ''}${whole.toString()}`;
  }

  const fractionStr = fraction.toString().padStart(decimals, '0');
  const trimmedFraction = fractionStr.replace(/0+$/, '');

  return `${isNegative ? '-' : ''}${whole.toString()}.${trimmedFraction}`;
}

/**
 * Sums an array of decimal strings with arbitrary precision using BigInt.
 */
export function sumDecimalAmounts(
  amounts: Array<string | number | { toString(): string } | null | undefined>,
  decimals = 7,
): string {
  let total = 0n;
  for (const amt of amounts) {
    total += parseDecimalToBigInt(amt, decimals);
  }
  return formatBigIntToDecimal(total, decimals);
}
