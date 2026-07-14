const fs = require('fs');
const { deepMerge } = require('./merge');

function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: node index.js <file1> <file2> [output_file]');
    process.exit(1);
  }

  const file1Path = args[0];
  const file2Path = args[1];
  const outputPath = args[2];

  let data1, data2;

  try {
    data1 = JSON.parse(fs.readFileSync(file1Path, 'utf8'));
  } catch (e) {
    console.error(`Error reading/parsing ${file1Path}: ${e.message}`);
    process.exit(1);
  }

  try {
    data2 = JSON.parse(fs.readFileSync(file2Path, 'utf8'));
  } catch (e) {
    console.error(`Error reading/parsing ${file2Path}: ${e.message}`);
    process.exit(1);
  }

  const merged = deepMerge(data1, data2);
  const resultString = JSON.stringify(merged, null, 2);

  if (outputPath) {
    try {
      fs.writeFileSync(outputPath, resultString);
    } catch (e) {
      console.error(`Error writing to ${outputPath}: ${e.message}`);
      process.exit(1);
    }
  } else {
    process.stdout.write(resultString + '\n');
  }
}

if (require.main === module) {
  main();
}
