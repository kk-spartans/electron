import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(root, "public/rdkit");

await mkdir(destination, { recursive: true });
await Promise.all([
  copyFile(
    resolve(root, "node_modules/@rdkit/rdkit/dist/RDKit_minimal.wasm"),
    resolve(destination, "RDKit_minimal.wasm"),
  ),
  copyFile(
    resolve(root, "node_modules/@rdkit/rdkit/dist/RDKit_minimal.js"),
    resolve(destination, "RDKit_minimal.js"),
  ),
]);
