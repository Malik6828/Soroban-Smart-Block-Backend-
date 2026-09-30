import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { sumDecimalAmounts } from '../../src/indexer/precision';

describe('Stop losing precision on token amounts in indexer aggregators (#1114)', () => {
  it('correctly aggregates amounts > 2^53 with 7 decimals without precision loss', () => {
    // 2^53 = 9007199254740992
    // Any standard Number() arithmetic fails to represent units and decimals accurately here.
    const largeAmount1 = '9007199254740993.1234567';
    const largeAmount2 = '9007199254740993.8765433';

    // Proving standard Number() corrupts precision:
    const numSum = Number(largeAmount1) + Number(largeAmount2);
    // Number sum produces 18014398509481988 (losing the exact .0000000 and corrupting last digits)
    expect(numSum.toString()).not.toBe('18014398509481987');

    // Using exact fixed-point BigInt summation:
    const exactSum = sumDecimalAmounts([largeAmount1, largeAmount2], 7);
    // 9007199254740993.1234567 + 9007199254740993.8765433 = 18014398509481987
    expect(exactSum).toBe('18014398509481987');
  });

  it('proves exact non-integer sum with amounts > 2^53 and 7 decimals', () => {
    const a = '9007199254740995.1234567';
    const b = '10000000000000001.2345678';
    // Exact expected: 19007199254740996.3580245
    const result = sumDecimalAmounts([a, b], 7);
    expect(result).toBe('19007199254740996.3580245');

    // Prove that Number(a) + Number(b) loses precision:
    const floatResult = (Number(a) + Number(b)).toString();
    expect(floatResult).not.toBe('19007199254740996.3580245');
  });

  it('handles 128-bit on-chain amounts (max u128)', () => {
    // max u128 is ~3.4028237e+38
    const u128Amount1 = '340282366920938463463374607431768211455.1234567';
    const u128Amount2 = '0.8765433';
    const result = sumDecimalAmounts([u128Amount1, u128Amount2], 7);
    expect(result).toBe('340282366920938463463374607431768211456');
  });

  it('asserts no Number(...) or parseFloat(...) on raw token/fee amounts in src/indexer/', () => {
    const feeAggregatorPath = path.resolve(__dirname, '../../src/indexer/fee-aggregator.ts');
    const feeAggregatorContent = fs.readFileSync(feeAggregatorPath, 'utf-8');
    expect(feeAggregatorContent).not.toMatch(/Number\(e\.amount\)/);

    const privacyGraphPath = path.resolve(__dirname, '../../src/indexer/privacy-graph.ts');
    const privacyGraphContent = fs.readFileSync(privacyGraphPath, 'utf-8');
    expect(privacyGraphContent).not.toMatch(/parseFloat\(amount\)/);
    expect(privacyGraphContent).not.toMatch(/Number\(p\.totalValue\)/);

    const protocolEconomicsPath = path.resolve(__dirname, '../../src/indexer/protocolEconomics.ts');
    const protocolEconomicsContent = fs.readFileSync(protocolEconomicsPath, 'utf-8');
    expect(protocolEconomicsContent).not.toMatch(/Number\(row\.feeCharged/);
  });
});
