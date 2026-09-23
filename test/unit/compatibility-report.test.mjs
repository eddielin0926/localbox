import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  createCompatibilityReport,
  renderTextCompatibilityReport,
  validateArtifactMappingManifest,
  validateCompatibilityManifest,
} from "../../scripts/compatibility-report.mjs";

const schema = JSON.parse(await readFile(
  new URL("../../src/frontend/compatibility-manifest.schema.json", import.meta.url),
  "utf8",
));
const vercelManifest = JSON.parse(await readFile(
  new URL("../../src/frontend/manifests/vercel.json", import.meta.url),
  "utf8",
));
const artifactMappingManifest = JSON.parse(await readFile(
  new URL("../../src/frontend/artifact-mapping-manifest.json", import.meta.url),
  "utf8",
));

const declarationStatus = (manifest) => ({
  status: "not-installed",
  package: manifest.upstream.package,
  version: manifest.upstream.version,
});

describe("frontend compatibility manifests", () => {
  test("accepts the versioned Vercel data manifest", () => {
    expect(validateCompatibilityManifest(structuredClone(vercelManifest), schema)).toEqual(
      vercelManifest,
    );
  });

  test("accepts the shared artifact mapping manifest and its #64 policy link", () => {
    expect(validateArtifactMappingManifest(
      structuredClone(artifactMappingManifest),
      schema,
    )).toEqual(artifactMappingManifest);

    const report = createCompatibilityReport(
      [vercelManifest],
      { vercel: declarationStatus(vercelManifest) },
      schema,
      artifactMappingManifest,
    );
    expect(report.artifactMappings.policy).toEqual({
      issue: 64,
      url: "https://github.com/eddielin0926/localbox/issues/64",
    });
    expect(report.artifactMappings.total.support).toMatchObject({
      native: 3,
      partial: 6,
      "not-applicable": 3,
      unsupported: 5,
    });
    expect(renderTextCompatibilityReport(report)).toContain(
      "Shared provider artifact mappings",
    );
  });

  test("rejects duplicate and unknown public surfaces", () => {
    const duplicate = structuredClone(vercelManifest);
    duplicate.publicSurfaces.push("Sandbox");
    expect(() => validateCompatibilityManifest(duplicate, schema)).toThrow(
      "Duplicate public surface: Sandbox",
    );

    const unknown = structuredClone(vercelManifest);
    unknown.entries[0].surface = "HostedControlPlane";
    expect(() => validateCompatibilityManifest(unknown, schema)).toThrow(
      "Unknown public surface",
    );

    const unchecked = structuredClone(vercelManifest);
    unchecked.declarationChecks.pop();
    expect(() => validateCompatibilityManifest(unchecked, schema)).toThrow(
      "Public surface has no declaration drift check",
    );
  });

  test("rejects duplicate entries, unknown classifications, and missing rationales", () => {
    const duplicate = structuredClone(vercelManifest);
    duplicate.entries.push(structuredClone(duplicate.entries[0]));
    expect(() => validateCompatibilityManifest(duplicate, schema)).toThrow(
      "Duplicate compatibility entry",
    );

    const unknown = structuredClone(vercelManifest);
    unknown.entries[0].support = "supported";
    expect(() => validateCompatibilityManifest(unknown, schema)).toThrow(
      "Unknown support classification",
    );

    const noRationale = structuredClone(vercelManifest);
    delete noRationale.entries[0].rationale;
    expect(() => validateCompatibilityManifest(noRationale, schema)).toThrow(
      "rationale must be a non-empty string",
    );
  });

  test("orders all frontends stably while a single-frontend report retains exact upstream identity", () => {
    const alpha = structuredClone(vercelManifest);
    alpha.frontend = "alpha";
    alpha.displayName = "Alpha Sandbox";
    alpha.contract = "localbox/alpha";
    alpha.upstream.package = "@example/alpha";
    alpha.upstream.version = "1.2.3";

    const checks = {
      alpha: declarationStatus(alpha),
      vercel: declarationStatus(vercelManifest),
    };
    const all = createCompatibilityReport([vercelManifest, alpha], checks, schema);
    expect(all.frontends.map(({ frontend }) => frontend)).toEqual(["alpha", "vercel"]);
    expect(JSON.stringify(createCompatibilityReport([vercelManifest, alpha], checks, schema))).toBe(
      JSON.stringify(all),
    );

    const one = createCompatibilityReport(
      [vercelManifest],
      { vercel: declarationStatus(vercelManifest) },
      schema,
    );
    expect(one.frontends).toHaveLength(1);
    expect(one.frontends[0].upstream).toMatchObject({
      package: "@vercel/sandbox",
      version: "3.3.0",
      documentation: "https://vercel.com/docs/sandbox/sdk-reference",
      assessed: "2026-09-16",
    });
    expect(renderTextCompatibilityReport(one)).toContain(
      "Upstream: @vercel/sandbox@3.3.0",
    );
  });

  test("never counts not-applicable or unsupported entries as supported", () => {
    const manifest = structuredClone(vercelManifest);
    const native = manifest.entries.find((entry) => entry.support === "native");
    native.support = "not-applicable";
    native.rationale = "This cloud-only concern has no local semantic effect.";
    validateCompatibilityManifest(manifest, schema);

    const report = createCompatibilityReport(
      [manifest],
      { vercel: declarationStatus(manifest) },
      schema,
    ).frontends[0];
    expect(report.total.supported).toBe(
      report.total.support.native + report.total.support.emulated + report.total.support.partial,
    );
    expect(report.total.support["not-applicable"]).toBe(1);
    expect(report.total.supported + report.total.support["not-applicable"] +
      report.total.support.unsupported).toBe(report.total.total);
  });
});
