import { basename } from "node:path";
import { source } from "@vercel/sandbox/subpath";

console.log(`${source}:${basename("/tmp/unrelated.txt")}`);
