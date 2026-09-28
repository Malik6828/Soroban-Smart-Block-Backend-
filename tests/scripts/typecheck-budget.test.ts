import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TYPE_ERROR_BUDGET } from '../../scripts/typecheck-budget';

describe('Typecheck budget reconciliation (#1113)', () => {
  it('asserts TYPE_ERROR_BUDGET is 1012', () => {
    expect(TYPE_ERROR_BUDGET).toBe(1012);
  });

  it('asserts package.json enforces TYPE_ERROR_BUDGET', () => {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    expect(pkg.scripts['typecheck:budget']).toContain(`--max-errors ${TYPE_ERROR_BUDGET}`);
    expect(pkg.scripts['typecheck:budget:ci']).toContain(`--max-errors ${TYPE_ERROR_BUDGET}`);
  });

  it('asserts .github/workflows/ci.yml step label matches TYPE_ERROR_BUDGET', () => {
    const ciPath = path.resolve(__dirname, '../../.github/workflows/ci.yml');
    const ciContent = fs.readFileSync(ciPath, 'utf-8');
    expect(ciContent).toMatch(new RegExp(`Type-check \\(src, budget ${TYPE_ERROR_BUDGET}\\)`));
  });

  it('asserts README.md documents the exact TYPE_ERROR_BUDGET', () => {
    const readmePath = path.resolve(__dirname, '../../README.md');
    const readmeContent = fs.readFileSync(readmePath, 'utf-8');
    expect(readmeContent).toMatch(
      new RegExp(`currently ${TYPE_ERROR_BUDGET} pre-existing errors being paid down toward 0`),
    );
  });
});
