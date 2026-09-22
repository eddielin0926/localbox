import { describe, expect, test } from "vitest";
import { SandboxSourceError } from "../../src/backends/container-engine/errors.js";

describe("container-engine source diagnostics", () => {
  test("reports the failed stage and stderr without exposing source credentials", () => {
    const sourceUrl = "https://source-user:source-password@example.test/private.git?token=source-token";
    const error = new SandboxSourceError(
      "git",
      "clone",
      new Error(`fatal: unable to access '${sourceUrl}': authentication failed for source-password`),
      {
        exitCode: 128,
        redactions: [sourceUrl, "source-user", "source-password", "source-token"],
      },
    );

    expect(error).toMatchObject({
      sourceType: "git",
      stage: "clone",
      exitCode: 128,
      diagnostic: "fatal: unable to access '[redacted]': authentication failed for [redacted]",
    });
    expect(error.message).toContain("during clone (exit code 128)");
    expect(error.message).toContain("authentication failed");
    expect(error.message).not.toContain("source-user");
    expect(error.message).not.toContain("source-password");
    expect(error.message).not.toContain("source-token");
  });
});
