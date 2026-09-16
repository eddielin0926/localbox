import type { ResolveHook } from "node:module";

const VERCEL_SANDBOX_SPECIFIER = "@vercel/sandbox";

let localboxVercelUrl: string;

export function initialize(url: string): void {
  localboxVercelUrl = url;
}

export const resolve: ResolveHook = (specifier, context, nextResolve) =>
  nextResolve(specifier === VERCEL_SANDBOX_SPECIFIER ? localboxVercelUrl : specifier, context);
