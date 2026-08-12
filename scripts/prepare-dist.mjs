import assert from "node:assert/strict";
import { chmodSync, readFileSync } from "node:fs";

const cliPath = new URL("../dist/channels/cli.js", import.meta.url);
assert.match(readFileSync(cliPath, "utf8"), /^#!\/usr\/bin\/env node\r?\n/);
chmodSync(cliPath, 0o755);
