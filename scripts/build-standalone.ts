/**
 * pnpm build:standalone — one self-contained HTML page that runs the whole
 * AgentGuard demo in the browser (no server): the real API handler, Policy
 * Engine, Risk Monitor, vault simulator, agent and dashboard.
 *
 * Node built-ins are swapped for browser equivalents:
 *   ed25519.ts → ed25519.portable.ts, sha.ts → sha.portable.ts,
 *   node:events / node:fs / node:path → apps/standalone/src/node-shims.ts
 *
 * The WebGL planet (apps/web/planet.js) is not bundled: it imports three.js
 * r0.143 from a CDN through an import map, exactly like the dev page, so it is
 * inlined as its own module script next to the import map.
 *
 * Output: dist/standalone/agentguard.html (also a fragment without
 * <html>/<head>/<body> wrappers at dist/standalone/agentguard.fragment.html
 * for hosts that add their own document skeleton).
 */
import { build, type Plugin } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shims = resolve(root, "apps/standalone/src/node-shims.ts");

const browser: Plugin = {
  name: "agentguard-browser",
  setup(b) {
    b.onResolve({ filter: /^node:(events|fs|fs\/promises|path)$/ }, () => ({ path: shims }));
    b.onResolve({ filter: /^node:/ }, (a) => ({ errors: [{ text: `${a.path} is not available in the browser build (imported from ${a.importer})` }] }));
    b.onResolve({ filter: /^\.\/ed25519\.ts$/ }, (a) => ({ path: resolve(dirname(a.importer), "ed25519.portable.ts") }));
    b.onResolve({ filter: /^\.\/sha\.ts$/ }, (a) => ({ path: resolve(dirname(a.importer), "sha.portable.ts") }));
  },
};

const result = await build({
  entryPoints: [resolve(root, "apps/standalone/src/main.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  write: false,
  legalComments: "none",
  plugins: [browser],
  logLevel: "warning",
});
const js = result.outputFiles[0]!.text.replace(/<\/script/gi, "<\\/script");

const html = readFileSync(resolve(root, "apps/web/index.html"), "utf8");
const css = readFileSync(resolve(root, "apps/web/style.css"), "utf8");
const fonts = /<link href="https:\/\/fonts\.googleapis\.com[^>]+>/.exec(html)?.[0] ?? "";
const importmap = /<script type="importmap">[\s\S]*?<\/script>/.exec(html)?.[0];
const body = /<body>([\s\S]*?)<script/.exec(html)?.[1];
if (!body || !importmap) throw new Error("could not find page body markup or import map");
const planet = readFileSync(resolve(root, "apps/web/planet.js"), "utf8").replace(/<\/script/gi, "<\\/script");

const head = `<title>AgentGuard</title>
<meta name="description" content="AgentGuard: a policy firewall for AI agents that spend money on NEAR. Interactive demo.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${fonts}
<style>${css}</style>
${importmap}`;
const script = `<script type="module">${js}</script>\n<script type="module">${planet}</script>`;

const out = resolve(root, "dist/standalone");
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, "agentguard.fragment.html"), `${head}\n${body.trim()}\n${script}\n`);
writeFileSync(resolve(out, "agentguard.html"), `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${head}\n</head>\n<body>\n${body.trim()}\n${script}\n</body>\n</html>\n`);
console.log(`dist/standalone/agentguard.html  ${(Buffer.byteLength(js) / 1024).toFixed(0)} KB of JS`);
