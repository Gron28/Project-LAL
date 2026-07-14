const fs = require('fs');
const path = require('path');
const { deepMerge } = require('./deep-merge');

const args = process.argv.slice(2);
const [file1, file2, outputFile] = args;

if (!file1 || !file2) {
  console.error('Usage: node index.js <file1> <file2> [outputFile]');
  process.exit(1);
}

const config1 = fs.readFileSync(file1, 'utf-8');
const config2 = fs.readFileSync(file2, 'utf-8');

try {
  const merged = deepMerge(JSON.parse(config1), JSON.parse(config2));
  if (outputFile) {
    fs.writeFileSync(outputFile, JSON.stringify(merged, null, 2));
    console.log(`Merged config written to ${outputFile}`);
  } else {
    console.log(JSON.stringify(merged, null, 2));
  }
} catch (err) {
  console.error('Error merging config:', err.message);
  process.exit(1);
}