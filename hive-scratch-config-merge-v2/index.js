const fs = require('fs');
const path = require('path');

function deepMerge(target, source) {
  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      const targetVal = target[key];
  if (targetVal === undefined) {
    continue;
  }
      const sourceVal = source[key];

      if (targetVal !== null && typeof targetVal === 'object' && sourceVal !== null && typeof sourceVal === 'object') {
        deepMerge(targetVal, sourceVal);
      } else if (Array.isArray(targetVal) && Array.isArray(sourceVal)) {
        target[key] = sourceVal;
      } else {
        target[key] = sourceVal;
      }
    }
  }
}

function readJsonFile(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error(`Error reading JSON file: ${filePath}`);
    console.error(err.message);
    process.exit(1);
  }
}

function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Error writing JSON file: ${filePath}`);
    console.error(err.message);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: config-merge <file1.json> <file2.json> [output.json]');
    process.exit(1);
  }

  const file1 = args[0];
  const file2 = args[1];
  const outputFile = args.length > 2 ? args[2] : null;

  const config1 = readJsonFile(file1);
  const config2 = readJsonFile(file2);

  const mergedConfig = deepMerge({}, config1);
  deepMerge(mergedConfig, config2);
  deepMerge(mergedConfig, config2);

  if (outputFile) {
    writeJsonFile(outputFile, mergedConfig);
    console.log(`Merged configuration written to: ${outputFile}`);
  } else {
    console.log(JSON.stringify(mergedConfig, null, 2));
  }
}

main();