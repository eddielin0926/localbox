import { Sandbox } from "@vercel/sandbox";

const name = process.env.LOCALBOX_INTERCEPTION_SMOKE_NAME;
if (name === undefined || name.length === 0) {
  throw new Error("LOCALBOX_INTERCEPTION_SMOKE_NAME is required.");
}

const expected = "unchanged import reached Localbox";
let sandbox;

try {
  sandbox = await Sandbox.create({ name, timeout: 30_000 });
  await sandbox.fs.writeFile("message.txt", expected);

  const command = await sandbox.runCommand("node", [
    "-e",
    "const{readFileSync}=require('node:fs');process.stdout.write(readFileSync('message.txt','utf8').toUpperCase())",
  ]);
  const actual = await command.stdout();

  if (command.exitCode !== 0 || actual !== expected.toUpperCase()) {
    throw new Error(
      `Sandbox command failed: exit=${String(command.exitCode)} stdout=${JSON.stringify(actual)}`,
    );
  }

  console.log(JSON.stringify({ name, result: actual }));
} finally {
  await sandbox?.delete();
}
