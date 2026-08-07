'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Recursively collect JavaScript files from a directory.
 *
 * @param {string} directory Directory to scan.
 * @returns {string[]} Absolute file paths.
 */
function collectJavaScriptFiles(directory) {
  if (!fs.existsSync(directory)) return [];

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectJavaScriptFiles(target));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target);
  }
  return files;
}

/**
 * Run Node's parser against every source and test file.
 *
 * The script is intentionally implemented in Node rather than shell commands so it
 * works consistently on macOS, Linux and Windows development machines.
 */
function main() {
  const roots = ['src', 'test', 'scripts'].map((directory) => path.resolve(process.cwd(), directory));
  const files = roots.flatMap(collectJavaScriptFiles).sort();

  if (!files.length) throw new Error('No JavaScript files were found to check');

  for (const file of files) {
    // Avoid recursively launching this script while checking it: `node --check`
    // only parses the file and never executes its contents.
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }

  console.log(`Syntax check passed for ${files.length} JavaScript files.`);
}

main();
