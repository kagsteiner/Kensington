#!/usr/bin/env node
// Runs the Kensington test suite in Node: node tests/run-tests.js
var tests = require('./tests.js');
var r = tests.report();
console.log(r.lines.join('\n'));
process.exit(r.failed === 0 ? 0 : 1);
