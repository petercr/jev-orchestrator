// A local fixture child, substituted only at the process boundary.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const active = process.env.TERMINAL_CASE.startsWith('active');
const firstRepair = process.env.TERMINAL_CASE === 'repair' && readFileSync('value.mjs', 'utf8').includes('= 1');
writeFileSync('value.mjs', `export const value = ${active || firstRepair ? 3 : 2};\n`);
writeFileSync('worker.pid', String(process.pid));
if (active) {
  if (process.platform !== 'win32') {
    // Prove process-group escalation also drains a TERM-resistant descendant.
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      "import {writeFileSync} from 'node:fs';writeFileSync('descendant.pid',String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"],
    { stdio: 'ignore' });
    child.unref();
  }
  setInterval(() => {}, 1_000);
} else {
  console.log('Fixture edits prepared. Independent validation was not run.');
}
