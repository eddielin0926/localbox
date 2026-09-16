import { readFile } from "node:fs/promises";

const manifestUrl = new URL("../src/vercel/compatibility.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const allowed = {
  availability: new Set(manifest.dimensions.availability),
  types: new Set(manifest.dimensions.types),
  behavior: new Set(manifest.dimensions.behavior),
};
const seen = new Set();

function score(entries) {
  let available = 0;
  let types = 0;
  let behavior = 0;
  for (const entry of entries) {
    if (seen.has(entry.name)) throw new Error(`Duplicate compatibility entry: ${entry.name}`);
    seen.add(entry.name);
    for (const dimension of Object.keys(allowed)) {
      if (!allowed[dimension].has(entry[dimension])) {
        throw new Error(`Invalid ${dimension} value for ${entry.name}: ${entry[dimension]}`);
      }
    }
    if (entry.availability === "supported") available += 1;
    if (entry.types === "compatible") types += 1;
    if (entry.behavior === "compatible") behavior += 1;
  }
  return { total: entries.length, available, types, behavior };
}

async function publicMethodNames(fileUrl, className, staticPrefix, instancePrefix) {
  const sourceText = await readFile(fileUrl, "utf8");
  const classStart = sourceText.indexOf(`declare class ${className}`);
  const bodyStart = sourceText.indexOf("{", classStart);
  const classEnd = /^}/m.exec(sourceText.slice(bodyStart + 1));
  if (classStart === -1 || bodyStart === -1 || classEnd === null) {
    throw new Error(`Could not find ${className} in ${fileUrl.pathname}`);
  }

  const body = sourceText.slice(bodyStart + 1, bodyStart + 1 + classEnd.index);
  const declaration = /^  (static )?([A-Za-z][A-Za-z0-9]*)(?:<[^(\n]*>)?\(/gm;
  const methods = new Set();
  for (const match of body.matchAll(declaration)) {
    const name = match[2];
    if (name === undefined || name === "constructor") continue;
    const documentationStart = body.lastIndexOf("/**", match.index);
    const documentation = documentationStart === -1
      ? ""
      : body.slice(documentationStart, match.index);
    if (documentation.includes("@deprecated")) continue;
    const prefix = match[1] === undefined ? instancePrefix : staticPrefix;
    methods.add(`${prefix}.${name}`);
  }
  return methods;
}

function assertSameMethods(surface, expected) {
  const declared = new Set(manifest.surfaces[surface].map((entry) => entry.name));
  const missing = [...expected].filter((name) => !declared.has(name));
  const extra = [...declared].filter((name) => !expected.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${surface} manifest drift. Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}.`,
    );
  }
}

const vercelEntry = new URL(import.meta.resolve("@vercel/sandbox"));
await Promise.all([
  publicMethodNames(new URL("./sandbox.d.ts", vercelEntry), "Sandbox", "Sandbox", "sandbox")
    .then((methods) => assertSameMethods("Sandbox", methods)),
  publicMethodNames(new URL("./command.d.ts", vercelEntry), "Command", "Command", "command")
    .then((methods) => assertSameMethods("Command", methods)),
  publicMethodNames(new URL("./filesystem.d.ts", vercelEntry), "FileSystem", "FileSystem", "fs")
    .then((methods) => assertSameMethods("FileSystem", methods)),
]);

const categories = Object.fromEntries(
  Object.entries(manifest.surfaces).map(([name, entries]) => [name, score(entries)]),
);
const total = Object.values(categories).reduce(
  (sum, value) => ({
    total: sum.total + value.total,
    available: sum.available + value.available,
    types: sum.types + value.types,
    behavior: sum.behavior + value.behavior,
  }),
  { total: 0, available: 0, types: 0, behavior: 0 },
);

function ratio(value, totalCount) {
  return `${value}/${totalCount} (${((value / totalCount) * 100).toFixed(1)}%)`;
}

const report = {
  reference: manifest.reference,
  categories,
  total,
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`Vercel Sandbox compatibility against ${manifest.reference.package}@${manifest.reference.version}`);
  console.log("Surface     Available       Type-compatible  Behavior-compatible");
  for (const [name, values] of Object.entries(categories)) {
    console.log(
      `${name.padEnd(11)} ${ratio(values.available, values.total).padEnd(15)} ${ratio(values.types, values.total).padEnd(16)} ${ratio(values.behavior, values.total)}`,
    );
  }
  console.log(
    `${"Total".padEnd(11)} ${ratio(total.available, total.total).padEnd(15)} ${ratio(total.types, total.total).padEnd(16)} ${ratio(total.behavior, total.total)}`,
  );
}
