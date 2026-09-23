import {
  checkDeclarationDrift,
  createCompatibilityReport,
  loadArtifactMappingManifest,
  loadCompatibilityManifests,
  loadCompatibilitySchema,
  renderTextCompatibilityReport,
} from "./compatibility-report.mjs";

const USAGE = [
  "Usage: node scripts/report-compatibility.mjs [--all | --frontend <name>] [--json]",
  "",
  "With no selection option, all frontend manifests are reported in stable name order.",
].join("\n");

function parseArguments(arguments_) {
  let frontend = null;
  let all = false;
  let json = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--all") {
      all = true;
    } else if (argument === "--frontend") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--frontend requires a frontend name.");
      }
      if (frontend !== null) throw new Error("--frontend may be specified only once.");
      frontend = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown compatibility report option: ${argument}.`);
    }
  }
  if (all && frontend !== null) throw new Error("--all and --frontend are mutually exclusive.");
  return { frontend, json };
}

const options = parseArguments(process.argv.slice(2));
const schema = await loadCompatibilitySchema();
const available = await loadCompatibilityManifests({ schema });
const artifactMappingManifest = await loadArtifactMappingManifest({ schema });
const manifests = options.frontend === null
  ? available
  : available.filter((manifest) => manifest.frontend === options.frontend);
if (manifests.length === 0) {
  throw new Error(
    `Unknown frontend \"${options.frontend}\". Available frontends: ${available.map((manifest) => manifest.frontend).join(", ")}.`,
  );
}

const declarationChecks = Object.fromEntries(
  await Promise.all(
    manifests.map(async (manifest) => [
      manifest.frontend,
      await checkDeclarationDrift(manifest),
    ]),
  ),
);
const report = createCompatibilityReport(
  manifests,
  declarationChecks,
  schema,
  artifactMappingManifest,
);
process.stdout.write(
  options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderTextCompatibilityReport(report),
);
