const fs = require('fs');
const { parse, stringify } = require('json5');

const args = process.argv.slice(2);
const [file1, file2, outputFile] = args;

if (args.length < 2) {
  console.error('Usage: node index.js <file1> <file2> [outputFile]');
  process.exit(1);
}

const merge = (obj1, obj2) => {
  const result = { ...obj1 };
  for (const key in obj2) {
    if (obj1[key] === null) {
      result[key] = obj2[key];
    } else if (typeof obj1[key] === 'object' && typeof obj2[key] === 'object') {
      result[key] = merge(obj1[key], obj2[key]);
    } else if (Array.isArray(obj1[key]) && Array.isArray(obj2[key])) {
      result[key] = obj2[key];
    } else {
      result[key] = obj2[key];
    }
  }
  return result;
};

const main = () => {
  try {
    const data1 = parse(readFileSync(file1, 'utf-8'));
    const data2 = parse(readFileSync(file2, 'utf-8'));
    const merged = merge(data1, data2);

    if (outputFile) {
      writeFileSync(outputFile, stringify(merged, null, 2));
      console.log(`Merged configuration written to ${outputFile}`);
    } else {
      console.log(stringify(merged, null, 2));
    }
  } catch (error) {
    console.error('Error merging configurations:', error.message);
    process.exit(1);
  }
};

main();