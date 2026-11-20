/**
 * Prints one line per failed test from a Playwright JSON report, so a CI log ends with the reasons.
 *
 *   pnpm e2e --reporter=list,json    (with PLAYWRIGHT_JSON_OUTPUT_NAME=results.json)
 *   node e2e/failures.mjs results.json
 */
import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const plain = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');
const walk = (suite, file) => {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      const failed = (test.results ?? []).filter((r) => r.status !== 'passed' && r.status !== 'skipped').pop();
      if (!failed || test.status === 'expected') continue;
      const where = failed.error?.location ? `:${failed.error.location.line}` : '';
      const lines = plain(failed.error?.message ?? 'no message').split('\n').filter((l) => l.trim()).slice(0, 6).join(' | ');
      console.log(`${file}${where} ${spec.title}\n    ${lines.slice(0, 500)}`);
    }
  }
  for (const child of suite.suites ?? []) walk(child, child.file ?? file);
};
for (const suite of report.suites ?? []) walk(suite, suite.file);
