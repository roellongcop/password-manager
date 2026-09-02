// Command-line runner:  node tests/run.mjs
import { runSuite } from './suite.js';

const results = await runSuite();
const failed = results.filter((result) => !result.ok);

for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
  if (!result.ok) console.log(`      ${result.message}`);
}

console.log(`\n${results.length - failed.length}/${results.length} passing`);
process.exit(failed.length ? 1 : 0);
