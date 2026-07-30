import { spawnSync } from "node:child_process";

type Step = {
  name: string;
  command: string;
  args: string[];
  allowFailure?: boolean;
};

function run({ name, command, args, allowFailure = false }: Step): boolean {
  console.log(`\n==> ${name}`);
  const result = spawnSync(command, args, { stdio: "inherit" });

  if (result.error && "code" in result.error && result.error.code === "ENOENT") {
    console.error(`\n!! ${name} failed: ${command} was not found`);
    return false;
  }

  if (result.status !== 0) {
    if (allowFailure) {
      console.warn(`\n-- ${name} reported recommendations (non-blocking)`);
      return true;
    }
    console.error(`\n!! ${name} failed with exit code ${result.status ?? "unknown"}`);
    return false;
  }

  return true;
}

const steps: Step[] = [
  {
    name: "gitleaks",
    command: "gitleaks",
    args: ["protect", "--staged", "--redact", "--verbose"],
  },
  {
    name: "app-prepare",
    command: "bun",
    args: ["run", "prepare:app"],
  },
  {
    name: "build",
    command: "next",
    args: ["build"],
  },
  {
    name: "oxlint",
    command: "oxlint",
    args: [
      "--type-aware",
      "--config",
      "devops/oxlintrc.json",
      "--tsconfig",
      "devops/tsconfig.json",
      ".",
      "--ignore-pattern",
      "public/rdkit/**",
    ],
  },
  {
    name: "oxfmt",
    command: "oxfmt",
    args: ["--check", ".", "--config", "devops/oxfmtrc.json"],
  },
  {
    name: "knip",
    command: "knip",
    args: ["--config", "devops/knip.json"],
  },
  {
    name: "e18e",
    command: "e18e-cli",
    args: ["analyze", "--log-level", "error"],
    allowFailure: true,
  },
  {
    name: "react-doctor",
    command: "react-doctor",
    args: ["devops", "--verbose"],
  },
  {
    name: "typecheck",
    command: "tsc",
    args: ["--noEmit", "-p", "devops/tsconfig.json"],
  },
];

const failures = steps.filter((step) => !run(step)).map((step) => step.name);

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}

console.log("\n✓ All checks passed");
