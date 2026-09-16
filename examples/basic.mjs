import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Sandbox, SandboxNotFoundError } from "localbox/vercel";

const name = `localbox-smoke-${randomUUID()}`;
const expected = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
let sandbox;

try {
  sandbox = await Sandbox.create({ name, ports: [3000], persistent: true });
  await sandbox.fs.writeFile(
    "server.mjs",
    `import { createServer } from "node:http";\ncreateServer((_request, response) => response.end("localbox-ok")).listen(3000, "0.0.0.0");\n`,
  );
  await sandbox.runCommand({
    cmd: "node",
    args: ["server.mjs"],
    detached: true,
  });

  const url = sandbox.domain(3000);
  let response;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      response = await fetch(url);
      if (response.ok) break;
    } catch {
      // The detached server is still starting.
    }
    await delay(50);
  }
  if (response === undefined || !response.ok || await response.text() !== "localbox-ok") {
    throw new Error("The sandbox HTTP server did not become ready.");
  }
  console.log("localbox-ok");

  await sandbox.fs.writeFile("state.bin", expected);
  await sandbox.stop();
  sandbox = await Sandbox.get({ name });
  const actual = await sandbox.fs.readFile("state.bin");
  if (!actual.equals(expected)) throw new Error("Persistent file contents changed after resume.");
  console.log("persistence-ok");
} finally {
  await sandbox?.delete();
}

try {
  await Sandbox.get({ name, resume: false });
  throw new Error("Deleted sandbox still exists.");
} catch (error) {
  if (!(error instanceof SandboxNotFoundError)) throw error;
}
console.log("cleanup-ok");
