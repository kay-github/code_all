import { spawnSync } from "node:child_process";

const DATABASE_ENV_NAMES = [
  "DATABASE_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_POSTGRES_URL",
  "POSTGRES_PRISMA_PRISMA_DATABASE_URL",
];

const mode = process.argv[2] ?? "build";
const validModes = new Set(["build", "production", "migrate"]);

if (!validModes.has(mode)) {
  console.error("Usage: bun scripts/build.mjs <build|production|migrate>");
  process.exit(2);
}

function commandEnvironment(requireDatabase) {
  const source = DATABASE_ENV_NAMES.find((name) => process.env[name]?.trim());
  if (!source) {
    if (requireDatabase) {
      throw new Error(`No database URL found. Set one of: ${DATABASE_ENV_NAMES.join(", ")}`);
    }
    return process.env;
  }

  if (source !== "DATABASE_URL") {
    console.log(`[build] Using ${source} as DATABASE_URL`);
  }
  return { ...process.env, DATABASE_URL: process.env[source] };
}

function requireMigrationConsent() {
  if (process.env.ALLOW_PRODUCTION_MIGRATIONS !== "1") {
    throw new Error(
      "Production migrations are disabled. Set ALLOW_PRODUCTION_MIGRATIONS=1 only in the production deployment environment.",
    );
  }
}

function runTool(tool, args, env) {
  console.log(`[build] ${tool} ${args.join(" ")}`);
  const bunExecutable = process.versions.bun ? process.execPath : "bun";
  const result = spawnSync(bunExecutable, ["x", tool, ...args], {
    env,
    shell: false,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

try {
  const deployMigrations = mode === "production" || mode === "migrate";
  if (deployMigrations) {
    requireMigrationConsent();
  }
  const env = commandEnvironment(deployMigrations);

  if (mode !== "migrate") {
    runTool("prisma", ["generate"], env);
    runTool("next", ["build"], env);
  }
  if (deployMigrations) {
    runTool("prisma", ["migrate", "deploy"], env);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[build] ${message}`);
  process.exit(1);
}
