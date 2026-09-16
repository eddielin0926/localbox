const signal = process.argv[2];

process.on(signal, () => {
  console.log(`RECEIVED:${signal}`);
  process.removeAllListeners(signal);
  setImmediate(() => process.kill(process.pid, signal));
});

console.log("READY");
process.stdin.resume();
