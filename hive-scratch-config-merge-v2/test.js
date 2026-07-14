const { exec } = require('child_process');

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(stderr);
        return;
      }
      resolve(stdout);
    });
  });
}

async function test() {
  try {
    const stdout = await runCommand('node index.js examples/config1.json examples/config2.json examples/expected-output.json');
    console.log('Test passed!');
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

test();