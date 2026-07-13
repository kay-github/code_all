"use strict";

const path = require("path");
const { runStockDailyWorker } = require("../lib/stockDailyWorker");

function parseArguments(args) {
  const force = args.includes("--force");
  const directoryArgument = args.find((value) => value.startsWith("--store-dir="));
  return {
    force,
    directory: directoryArgument
      ? path.resolve(directoryArgument.slice("--store-dir=".length))
      : undefined
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  try {
    const result = await runStockDailyWorker(options);
    console.log(JSON.stringify({
      ok: true,
      ...result
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      error: error.code || "UNKNOWN_ERROR",
      causeCode: error.details && error.details.causeCode || null,
      expectedAsOf: error.details && error.details.expectedAsOf || null,
      snapshotId: error.details && error.details.snapshotId || null
    }, null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArguments,
  main
};
