const assert = require('assert');

function testExpiry() {
  console.log("Running expiry tests...");
  
  const pastDate = new Date();
  pastDate.setDate(pastDate.getDate() - 10);
  
  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 10);

  const isExpiredPast = (date) => date.getTime() < Date.now();
  
  assert.strictEqual(isExpiredPast(pastDate), true, "Past date should be expired");
  assert.strictEqual(isExpiredPast(futureDate), false, "Future date should not be expired");

  console.log("All expiry tests passed!");
}

try {
  testExpiry();
} catch (e) {
  console.error("Expiry tests failed:", e);
  process.exit(1);
}
