// Global test setup
process.env.NODE_ENV = 'test';

// Suppress console logs during tests unless DEBUG is set
if (!process.env.DEBUG) {
  const noop = () => {};
  console.log = noop;
  console.info = noop;
  // Keep console.error and console.warn for debugging test failures
}
