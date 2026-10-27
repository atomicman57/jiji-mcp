import { writeFile } from "node:fs/promises";
import { featureMap } from "../src/catalog.mjs";
await writeFile(
  new URL("../FEATURES.json", import.meta.url),
  JSON.stringify(featureMap(), null, 2) + "\n",
);
