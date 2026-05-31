import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runTests } from "@vscode/test-electron";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = resolve(scriptDir, "..");
const repoRoot = resolve(extensionDevelopmentPath, "../..");
const extensionTestsPath = resolve(extensionDevelopmentPath, "out-test", "test", "electron", "index.js");
const rpcFixtureServerPath = resolve(extensionDevelopmentPath, "test", "fixtures", "rpcFixtureServer.mjs");
const workspacePath = resolve(repoRoot, "target", "vscode-test-workspace");
const settingsPath = resolve(workspacePath, ".vscode", "settings.json");
const rpcFixtureLogPath = resolve(workspacePath, ".prole-coder-test", "rpc-log.jsonl");
const profileSuffix = `${process.pid}-${Date.now()}`;
const userDataPath = resolve(repoRoot, "target", `vscode-test-user-data-${profileSuffix}`);
const extensionsPath = resolve(repoRoot, "target", `vscode-test-extensions-${profileSuffix}`);

delete process.env.ELECTRON_RUN_AS_NODE;
process.env.PROLE_CODER_VSCODE_TEST = "1";
process.env.PROLE_CODER_VSCODE_TEST_AUTO_APPROVE = "1";
process.env.PROLE_CODER_VSCODE_TEST_RPC_LOG = rpcFixtureLogPath;

mkdirSync(dirname(settingsPath), { recursive: true });
rmSync(rpcFixtureLogPath, { force: true });
writeFileSync(
  settingsPath,
  `${JSON.stringify(
    {
      "prole-coder.rpc.autoStart": false,
      "prole-coder.rpc.command": process.execPath,
      "prole-coder.rpc.args": [rpcFixtureServerPath, rpcFixtureLogPath],
    },
    null,
    2,
  )}\n`,
);

await runTests({
  extensionDevelopmentPath,
  extensionTestsPath,
  launchArgs: [
    `--folder-uri=${pathToFileURL(workspacePath).href}`,
    `--user-data-dir=${userDataPath}`,
    `--extensions-dir=${extensionsPath}`,
    "--disable-extensions",
    "--new-window",
  ],
});
