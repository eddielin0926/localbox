import { register } from "node:module";

const localboxVercelUrl = import.meta.resolve("localbox/vercel");

register("./resolve-hook.js", import.meta.url, {
  data: localboxVercelUrl,
});
