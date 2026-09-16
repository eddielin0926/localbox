import { Sandbox } from "@vercel/sandbox";

console.log(
  JSON.stringify({
    resolved: import.meta.resolve("@vercel/sandbox"),
    sandboxType: typeof Sandbox,
  }),
);
