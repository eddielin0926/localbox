import { readFile, readdir } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const schemaUrl = new URL("../src/frontend/compatibility-manifest.schema.json", import.meta.url);
export const manifestDirectoryUrl = new URL("../src/frontend/manifests/", import.meta.url);
export const artifactMappingManifestUrl = new URL(
  "../src/frontend/artifact-mapping-manifest.json",
  import.meta.url,
);

function objectAt(value, path) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${path} must be an object.`);
  }
  return value;
}

function nonEmptyString(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value;
}

function exactKeys(value, required, optional, path) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${path} is missing required property ${key}.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path} has unknown property ${key}.`);
  }
}

function stringArray(value, path, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    throw new Error(`${path} must be ${nonEmpty ? "a non-empty" : "an"} array.`);
  }
  return value.map((entry, index) => nonEmptyString(entry, `${path}[${index}]`));
}

function schemaValues(schema, definition) {
  const values = schema?.$defs?.[definition]?.enum;
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error(`Compatibility schema definition ${definition} must declare a string enum.`);
  }
  return values;
}

/** Validate structural and cross-record invariants not expressible by JSON Schema alone. */
export function validateCompatibilityManifest(manifestValue, schemaValue) {
  const schema = objectAt(schemaValue, "Compatibility schema");
  const manifest = objectAt(manifestValue, "Compatibility manifest");
  const required = [
    "$schema",
    "schemaVersion",
    "frontend",
    "displayName",
    "contract",
    "upstream",
    "notes",
    "publicSurfaces",
    "entries",
    "declarationChecks",
  ];
  exactKeys(manifest, required, [], "Compatibility manifest");

  if (manifest.$schema !== "../compatibility-manifest.schema.json") {
    throw new Error("Compatibility manifest must reference the shared compatibility-manifest.schema.json.");
  }
  const expectedVersion = schema?.properties?.schemaVersion?.const;
  if (manifest.schemaVersion !== expectedVersion) {
    throw new Error(`Unknown compatibility schema version: ${String(manifest.schemaVersion)}.`);
  }
  const frontend = nonEmptyString(manifest.frontend, "Compatibility manifest frontend");
  if (!/^[a-z][a-z0-9-]*$/.test(frontend)) {
    throw new Error(`Compatibility manifest frontend is invalid: ${frontend}.`);
  }
  nonEmptyString(manifest.displayName, "Compatibility manifest displayName");
  nonEmptyString(manifest.contract, "Compatibility manifest contract");

  const upstream = objectAt(manifest.upstream, "Compatibility manifest upstream");
  exactKeys(
    upstream,
    ["package", "version", "documentation", "assessed", "scope"],
    [],
    "Compatibility manifest upstream",
  );
  nonEmptyString(upstream.package, "Compatibility manifest upstream package");
  nonEmptyString(upstream.version, "Compatibility manifest upstream version");
  const documentation = nonEmptyString(
    upstream.documentation,
    "Compatibility manifest upstream documentation",
  );
  try {
    new URL(documentation);
  } catch {
    throw new Error("Compatibility manifest upstream documentation must be an absolute URL.");
  }
  const assessed = nonEmptyString(upstream.assessed, "Compatibility manifest upstream assessed");
  const assessedParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(assessed);
  const assessedDate = assessedParts === null
    ? null
    : new Date(Date.UTC(
      Number(assessedParts[1]),
      Number(assessedParts[2]) - 1,
      Number(assessedParts[3]),
    ));
  if (assessedDate === null || assessedDate.toISOString().slice(0, 10) !== assessed) {
    throw new Error("Compatibility manifest upstream assessed must be an ISO calendar date.");
  }
  nonEmptyString(upstream.scope, "Compatibility manifest upstream scope");
  stringArray(manifest.notes, "Compatibility manifest notes");

  const publicSurfaces = stringArray(
    manifest.publicSurfaces,
    "Compatibility manifest publicSurfaces",
    { nonEmpty: true },
  );
  const surfaceNames = new Set();
  for (const surface of publicSurfaces) {
    if (surfaceNames.has(surface)) throw new Error(`Duplicate public surface: ${surface}.`);
    surfaceNames.add(surface);
  }

  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error("Compatibility manifest entries must be a non-empty array.");
  }
  const supportValues = new Set(schemaValues(schema, "support"));
  const compatibilityValues = new Set(schemaValues(schema, "compatibility"));
  const seenEntries = new Set();
  const coveredSurfaces = new Set();
  for (const [index, entryValue] of manifest.entries.entries()) {
    const path = `Compatibility manifest entries[${index}]`;
    const entry = objectAt(entryValue, path);
    exactKeys(entry, ["surface", "name", "support", "types", "behavior"], ["rationale"], path);
    const surface = nonEmptyString(entry.surface, `${path}.surface`);
    const name = nonEmptyString(entry.name, `${path}.name`);
    if (!surfaceNames.has(surface)) throw new Error(`Unknown public surface for ${name}: ${surface}.`);
    coveredSurfaces.add(surface);
    if (seenEntries.has(name)) throw new Error(`Duplicate compatibility entry: ${name}.`);
    seenEntries.add(name);
    if (!supportValues.has(entry.support)) {
      throw new Error(`Unknown support classification for ${name}: ${String(entry.support)}.`);
    }
    if (!compatibilityValues.has(entry.types)) {
      throw new Error(`Unknown type compatibility for ${name}: ${String(entry.types)}.`);
    }
    if (!compatibilityValues.has(entry.behavior)) {
      throw new Error(`Unknown behavior compatibility for ${name}: ${String(entry.behavior)}.`);
    }
    if (entry.support !== "native") {
      nonEmptyString(entry.rationale, `${path}.rationale`);
    } else if (entry.rationale !== undefined) {
      nonEmptyString(entry.rationale, `${path}.rationale`);
    }
  }
  for (const surface of publicSurfaces) {
    if (!coveredSurfaces.has(surface)) throw new Error(`Public surface has no entries: ${surface}.`);
  }

  if (!Array.isArray(manifest.declarationChecks)) {
    throw new Error("Compatibility manifest declarationChecks must be an array.");
  }
  const checkedSurfaces = new Set();
  for (const [index, checkValue] of manifest.declarationChecks.entries()) {
    const path = `Compatibility manifest declarationChecks[${index}]`;
    const check = objectAt(checkValue, path);
    exactKeys(
      check,
      ["surface", "extractor", "path", "declaration", "staticPrefix", "instancePrefix"],
      [],
      path,
    );
    const surface = nonEmptyString(check.surface, `${path}.surface`);
    if (!surfaceNames.has(surface)) throw new Error(`Unknown declaration-check surface: ${surface}.`);
    if (checkedSurfaces.has(surface)) throw new Error(`Duplicate declaration check: ${surface}.`);
    checkedSurfaces.add(surface);
    if (check.extractor !== "typescript-class-methods") {
      throw new Error(`Unknown declaration extractor for ${surface}: ${String(check.extractor)}.`);
    }
    const declarationPath = nonEmptyString(check.path, `${path}.path`);
    if (!declarationPath.startsWith("./")) {
      throw new Error(`${path}.path must be package-relative and start with "./".`);
    }
    nonEmptyString(check.declaration, `${path}.declaration`);
    nonEmptyString(check.staticPrefix, `${path}.staticPrefix`);
    nonEmptyString(check.instancePrefix, `${path}.instancePrefix`);
  }
  for (const surface of publicSurfaces) {
    if (!checkedSurfaces.has(surface)) {
      throw new Error(`Public surface has no declaration drift check: ${surface}.`);
    }
  }
  return manifest;
}

/** Validate the shared provider-artifact policy against schema-v1 classifications. */
export function validateArtifactMappingManifest(manifestValue, schemaValue) {
  const schema = objectAt(schemaValue, "Compatibility schema");
  const manifest = objectAt(manifestValue, "Artifact mapping manifest");
  exactKeys(
    manifest,
    ["$schema", "schemaVersion", "policy", "entries"],
    [],
    "Artifact mapping manifest",
  );
  if (
    manifest.$schema !==
      "./compatibility-manifest.schema.json#/$defs/artifactMappingManifest"
  ) {
    throw new Error("Artifact mapping manifest must reference the shared compatibility schema.");
  }
  if (manifest.schemaVersion !== schema?.properties?.schemaVersion?.const) {
    throw new Error(`Unknown artifact mapping schema version: ${String(manifest.schemaVersion)}.`);
  }

  const policy = objectAt(manifest.policy, "Artifact mapping manifest policy");
  exactKeys(policy, ["issue", "url"], [], "Artifact mapping manifest policy");
  if (policy.issue !== 64) throw new Error("Artifact mapping manifest policy must link issue #64.");
  const policyUrl = nonEmptyString(policy.url, "Artifact mapping manifest policy URL");
  try {
    new URL(policyUrl);
  } catch {
    throw new Error("Artifact mapping manifest policy URL must be absolute.");
  }

  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error("Artifact mapping manifest entries must be a non-empty array.");
  }
  const contracts = new Set(
    schema?.$defs?.artifactMappingEntry?.properties?.contract?.enum ?? [],
  );
  const supportValues = new Set(schemaValues(schema, "support"));
  const seen = new Set();
  for (const [index, entryValue] of manifest.entries.entries()) {
    const path = `Artifact mapping manifest entries[${index}]`;
    const entry = objectAt(entryValue, path);
    exactKeys(entry, ["contract", "selector", "support", "rationale"], [], path);
    if (!contracts.has(entry.contract)) {
      throw new Error(`Unknown artifact mapping contract: ${String(entry.contract)}.`);
    }
    const selector = nonEmptyString(entry.selector, `${path}.selector`);
    if (!supportValues.has(entry.support)) {
      throw new Error(`Unknown artifact mapping support for ${selector}: ${String(entry.support)}.`);
    }
    nonEmptyString(entry.rationale, `${path}.rationale`);
    const key = `${entry.contract}\0${selector}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate artifact mapping entry: ${entry.contract} ${selector}.`);
    }
    seen.add(key);
  }
  return manifest;
}

export async function loadCompatibilitySchema(url = schemaUrl) {
  return JSON.parse(await readFile(url, "utf8"));
}

export async function loadArtifactMappingManifest({
  url = artifactMappingManifestUrl,
  schema = undefined,
} = {}) {
  const compatibilitySchema = schema ?? await loadCompatibilitySchema();
  return validateArtifactMappingManifest(
    JSON.parse(await readFile(url, "utf8")),
    compatibilitySchema,
  );
}

export async function loadCompatibilityManifests({
  directoryUrl = manifestDirectoryUrl,
  schema = undefined,
} = {}) {
  const compatibilitySchema = schema ?? await loadCompatibilitySchema();
  const files = (await readdir(directoryUrl, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) throw new Error("No frontend compatibility manifests were found.");

  const manifests = [];
  const frontends = new Set();
  for (const file of files) {
    const manifest = validateCompatibilityManifest(
      JSON.parse(await readFile(new URL(file, directoryUrl), "utf8")),
      compatibilitySchema,
    );
    if (frontends.has(manifest.frontend)) {
      throw new Error(`Duplicate frontend compatibility manifest: ${manifest.frontend}.`);
    }
    frontends.add(manifest.frontend);
    manifests.push(manifest);
  }
  return manifests.sort((left, right) => left.frontend.localeCompare(right.frontend));
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function typescriptClassMethods(sourceText, check, declarationUrl) {
  const declaration = escapeRegularExpression(check.declaration);
  const classStart = new RegExp(`declare\\s+class\\s+${declaration}(?:\\s|<|{)`).exec(sourceText);
  const bodyStart = classStart === null ? -1 : sourceText.indexOf("{", classStart.index);
  const classEnd = bodyStart === -1 ? null : /^}/m.exec(sourceText.slice(bodyStart + 1));
  if (classStart === null || bodyStart === -1 || classEnd === null) {
    throw new Error(`Could not find ${check.declaration} in ${declarationUrl.pathname}.`);
  }

  const body = sourceText.slice(bodyStart + 1, bodyStart + 1 + classEnd.index);
  const methodDeclaration = /^  (static )?([A-Za-z][A-Za-z0-9]*)(?:<[^\n(]*>)?\(/gm;
  const methods = new Set();
  for (const match of body.matchAll(methodDeclaration)) {
    const name = match[2];
    if (name === undefined || name === "constructor") continue;
    const documentationStart = body.lastIndexOf("/**", match.index);
    const documentation = documentationStart === -1 ? "" : body.slice(documentationStart, match.index);
    if (documentation.includes("@deprecated")) continue;
    const prefix = match[1] === undefined ? check.instancePrefix : check.staticPrefix;
    methods.add(`${prefix}.${name}`);
  }
  return methods;
}

const DECLARATION_EXTRACTORS = {
  "typescript-class-methods": typescriptClassMethods,
};

async function packageRoot(entryUrl, expectedPackage) {
  let current = dirname(fileURLToPath(entryUrl));
  const root = parse(current).root;
  for (;;) {
    try {
      const packageJson = JSON.parse(await readFile(join(current, "package.json"), "utf8"));
      if (packageJson.name === expectedPackage) return { root: current, packageJson };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (current === root) break;
    current = dirname(current);
  }
  throw new Error(`Could not locate package metadata for ${expectedPackage}.`);
}

/** Check installed upstream package identity and configured declaration surfaces. */
export async function checkDeclarationDrift(manifest) {
  let entryUrl;
  try {
    entryUrl = new URL(import.meta.resolve(manifest.upstream.package));
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      return {
        status: "not-installed",
        package: manifest.upstream.package,
        version: manifest.upstream.version,
      };
    }
    throw error;
  }

  const installed = await packageRoot(entryUrl, manifest.upstream.package);
  if (installed.packageJson.version !== manifest.upstream.version) {
    throw new Error(
      `${manifest.frontend} upstream version drift: assessed ${manifest.upstream.package}@${manifest.upstream.version}, installed ${installed.packageJson.version}.`,
    );
  }

  const installedRootUrl = pathToFileURL(`${installed.root}/`);
  for (const check of manifest.declarationChecks) {
    const declarationUrl = new URL(check.path, installedRootUrl);
    const extractor = DECLARATION_EXTRACTORS[check.extractor];
    if (extractor === undefined) {
      throw new Error(`Unknown declaration extractor: ${check.extractor}.`);
    }
    const declared = extractor(await readFile(declarationUrl, "utf8"), check, declarationUrl);
    const expected = new Set(
      manifest.entries.filter((entry) => entry.surface === check.surface).map((entry) => entry.name),
    );
    const missing = [...declared].filter((name) => !expected.has(name)).sort();
    const extra = [...expected].filter((name) => !declared.has(name)).sort();
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `${manifest.frontend} ${check.surface} declaration drift. Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}.`,
      );
    }
  }

  return {
    status: "checked",
    package: manifest.upstream.package,
    version: installed.packageJson.version,
    surfaces: manifest.declarationChecks.map((check) => check.surface),
  };
}

function emptyCounts(values) {
  return Object.fromEntries(values.map((value) => [value, 0]));
}

function summarizeEntries(entries, supportValues, compatibilityValues) {
  const support = emptyCounts(supportValues);
  const types = emptyCounts(compatibilityValues);
  const behavior = emptyCounts(compatibilityValues);
  for (const entry of entries) {
    support[entry.support] += 1;
    types[entry.types] += 1;
    behavior[entry.behavior] += 1;
  }
  return {
    total: entries.length,
    supported: support.native + support.emulated + support.partial,
    support,
    types,
    behavior,
  };
}

function summarizeSupportEntries(entries, supportValues) {
  const support = emptyCounts(supportValues);
  for (const entry of entries) support[entry.support] += 1;
  return {
    total: entries.length,
    supported: support.native + support.emulated + support.partial,
    support,
  };
}

/** Build a deterministic JSON-safe report for one or more validated manifests. */
export function createCompatibilityReport(
  manifests,
  declarationChecks,
  schema,
  artifactMappingManifest = null,
) {
  const supportValues = schemaValues(schema, "support");
  const compatibilityValues = schemaValues(schema, "compatibility");
  const ordered = [...manifests].sort((left, right) => left.frontend.localeCompare(right.frontend));
  const artifactMappings = artifactMappingManifest === null
    ? null
    : {
      policy: artifactMappingManifest.policy,
      contracts: [...new Set(
        artifactMappingManifest.entries.map(({ contract }) => contract),
      )].sort().map((contract) => ({
        contract,
        entries: artifactMappingManifest.entries.filter((entry) => entry.contract === contract),
        total: summarizeSupportEntries(
          artifactMappingManifest.entries.filter((entry) => entry.contract === contract),
          supportValues,
        ),
      })),
      total: summarizeSupportEntries(artifactMappingManifest.entries, supportValues),
    };
  return {
    schemaVersion: schema.properties.schemaVersion.const,
    artifactMappings,
    frontends: ordered.map((manifest) => {
      const surfaces = manifest.publicSurfaces.map((surface) => ({
        surface,
        ...summarizeEntries(
          manifest.entries.filter((entry) => entry.surface === surface),
          supportValues,
          compatibilityValues,
        ),
      }));
      return {
        frontend: manifest.frontend,
        displayName: manifest.displayName,
        contract: manifest.contract,
        upstream: manifest.upstream,
        notes: manifest.notes,
        declarations: declarationChecks[manifest.frontend],
        surfaces,
        total: summarizeEntries(manifest.entries, supportValues, compatibilityValues),
      };
    }),
  };
}

function ratio(value, total) {
  return `${value}/${total} (${total === 0 ? "0.0" : ((value / total) * 100).toFixed(1)}%)`;
}

export function renderTextCompatibilityReport(report) {
  const lines = [];
  if (report.artifactMappings !== null) {
    const mappings = report.artifactMappings;
    lines.push("Shared provider artifact mappings");
    lines.push(`Policy: #${mappings.policy.issue} ${mappings.policy.url}`);
    lines.push("Contract                             Total Native Emulated Partial N/A Unsupported Supported");
    for (const contract of [...mappings.contracts, { contract: "Total", total: mappings.total }]) {
      const summary = contract.total;
      lines.push(
        `${contract.contract.padEnd(36)} ${String(summary.total).padStart(5)} ${String(summary.support.native).padStart(6)} ${String(summary.support.emulated).padStart(8)} ${String(summary.support.partial).padStart(7)} ${String(summary.support["not-applicable"]).padStart(3)} ${String(summary.support.unsupported).padStart(11)} ${ratio(summary.supported, summary.total)}`,
      );
    }
  }
  for (const [index, frontend] of report.frontends.entries()) {
    if (lines.length > 0 || index > 0) lines.push("");
    lines.push(`${frontend.displayName} compatibility (${frontend.contract})`);
    lines.push(`Upstream: ${frontend.upstream.package}@${frontend.upstream.version}`);
    lines.push(`Documentation: ${frontend.upstream.documentation}`);
    lines.push(`Assessed: ${frontend.upstream.assessed}`);
    lines.push(
      frontend.declarations.status === "checked"
        ? `Declarations: checked ${frontend.declarations.package}@${frontend.declarations.version}`
        : `Declarations: not checked (${frontend.declarations.package}@${frontend.declarations.version} is not installed)`,
    );
    lines.push("Surface     Total Native Emulated Partial N/A Unsupported Supported       Types            Behavior");
    for (const surface of [...frontend.surfaces, { surface: "Total", ...frontend.total }]) {
      lines.push(
        `${surface.surface.padEnd(11)} ${String(surface.total).padStart(5)} ${String(surface.support.native).padStart(6)} ${String(surface.support.emulated).padStart(8)} ${String(surface.support.partial).padStart(7)} ${String(surface.support["not-applicable"]).padStart(3)} ${String(surface.support.unsupported).padStart(11)} ${ratio(surface.supported, surface.total).padEnd(15)} ${ratio(surface.types.compatible, surface.total).padEnd(16)} ${ratio(surface.behavior.compatible, surface.total)}`,
      );
    }
    lines.push("Notes:");
    for (const note of frontend.notes) lines.push(`- ${note}`);
  }
  return `${lines.join("\n")}\n`;
}
