/**
 * `npm run check`: syntax-check every JavaScript file and validate the
 * default configuration file against the schema.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = ['bin', 'src', 'scripts', 'test'];
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(?:m?js)$/.test(entry.name)) files.push(p);
  }
}
for (const d of dirs) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    process.stderr.write(`Syntax error in ${path.relative(root, f)}:\n${r.stderr}\n`);
  }
}
console.log(`Syntax check: ${files.length - failed}/${files.length} files OK`);

const { loadConfig } = await import('../src/config/load.js');
try {
  loadConfig();
  console.log('Configuration: scraper.config.json is valid');
} catch (err) {
  failed++;
  console.error(err.message);
}

// Every module must also load (catches bad imports that --check cannot see).
for (const f of files.filter((p) => p.includes(`${path.sep}src${path.sep}`))) {
  try {
    await import(f);
  } catch (err) {
    failed++;
    console.error(`Cannot load ${path.relative(root, f)}: ${err.message}`);
  }
}
console.log('Module load: done');
process.exit(failed ? 1 : 0);
