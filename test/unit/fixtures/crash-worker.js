// A stage B worker that dies before it is up, forked by stage-b.test.js to
// drive the restart backoff.
process.exit(3);
