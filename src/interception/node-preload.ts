import { register } from "node:module";

function describeCause(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const code =
    "code" in error && typeof error.code === "string" ? ` [${error.code}]` : "";
  return `${error.name}${code}: ${error.message}`;
}

try {
  const localboxVercelUrl = import.meta.resolve("localbox/vercel");

  register("./resolve-hook.js", import.meta.url, {
    data: localboxVercelUrl,
  });
} catch (cause) {
  throw new Error(
    "localbox: [LOCALBOX_HOOK_SETUP_FAILED] Localbox could not install its Node.js resolution hook. " +
      "The application was not started, and Localbox did not fall back to @vercel/sandbox. " +
      `Cause: ${describeCause(cause)}`,
    { cause },
  );
}
