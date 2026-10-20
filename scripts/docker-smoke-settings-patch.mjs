import { readFileSync, writeFileSync } from "node:fs";

const [file, proxyUrl] = process.argv.slice(2);
if (!file || !proxyUrl) {
  console.error("usage: node docker-smoke-settings-patch.mjs <settings file> <proxy url>");
  process.exit(2);
}
const src = readFileSync(file, "utf8");
const entry = `proxyUrl: ${JSON.stringify(proxyUrl)},`;
let out;
if (/\begress:\s*\{/u.test(src)) {
  out = src.replace(/\begress:\s*\{/u, (m) => `${m} ${entry}`);
} else if (/defineSettings\(\{/u.test(src)) {
  out = src.replace(/defineSettings\(\{/u, (m) => `${m}\n  egress: { ${entry} },`);
} else {
  console.error(`docker-smoke-settings-patch: ${file} has no \`egress: {\` group and no \`defineSettings({\` call to extend`);
  process.exit(1);
}
writeFileSync(file, out);
console.log(`docker-smoke-settings-patch: egress.proxyUrl = ${proxyUrl}`);
