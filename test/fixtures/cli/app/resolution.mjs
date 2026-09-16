import * as sandbox from "@vercel/sandbox";

console.log("providerMarker" in sandbox ? sandbox.providerMarker : "localbox");
