#!/usr/bin/env bun

import { runCli } from "./src/cli";
import { getErrorMessage } from "./src/errors";

try {
  await runCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${getErrorMessage(error)}\n`);
  process.exitCode = 1;
}
