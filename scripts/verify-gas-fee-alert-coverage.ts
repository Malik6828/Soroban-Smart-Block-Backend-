import fs from 'fs';
import path from 'path';

interface CoverageMetric {
  pct: number;
}

interface FileCoverage {
  statements: CoverageMetric;
  branches: CoverageMetric;
  functions: CoverageMetric;
  lines: CoverageMetric;
}

const summaryPath = path.resolve('coverage/coverage-summary.json');
const targets = [
  'src/indexer/gasFeeAlertEvaluator.ts',
  'src/services/gasFeeAlertDelivery.ts',
];
const minimum = 90;

if (!fs.existsSync(summaryPath)) {
  throw new Error('Coverage summary missing; run npm run test:coverage before this check.');
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as Record<string, FileCoverage>;
const entries = Object.entries(summary).map(([file, coverage]) => [
  file.replace(/\\/g, '/'),
  coverage,
] as const);
let failed = false;

for (const target of targets) {
  const entry = entries.find(([file]) => file.endsWith(`/${target}`));
  if (!entry) {
    process.stderr.write(`Coverage entry missing for ${target}\n`);
    failed = true;
    continue;
  }
  const [, coverage] = entry;
  for (const metric of ['statements', 'branches', 'functions', 'lines'] as const) {
    const pct = coverage[metric].pct;
    process.stdout.write(`${target} ${metric}: ${pct}% (minimum ${minimum}%)\n`);
    if (pct < minimum) failed = true;
  }
}

if (failed) process.exit(1);