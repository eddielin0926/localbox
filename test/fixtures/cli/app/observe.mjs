console.log(
  JSON.stringify({
    arguments: process.argv.slice(2),
    cwd: process.cwd(),
    environment: process.env.LOCALBOX_TEST_MARKER,
    nodeOptions: process.env.NODE_OPTIONS,
    existingPreloadRan: globalThis.existingPreloadRan === true,
  }),
);
