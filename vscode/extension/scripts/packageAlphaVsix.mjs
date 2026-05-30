#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createVSIX } = require("@vscode/vsce");
const { readVSIXPackage } = require("@vscode/vsce/out/zip");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const workspaceRoot = path.resolve(extensionRoot, "..", "..");
const outputDir = path.join(workspaceRoot, "target", "vsix");
const releaseChannel = "alpha";

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const manifestPath = path.join(extensionRoot, "package.json");
  const manifest = await readJson(manifestPath);
  assertAlphaManifestShape(manifest);

  await fs.mkdir(outputDir, { recursive: true });
  const packagePath = path.join(outputDir, `${manifest.name}-${manifest.version}-${releaseChannel}.vsix`);
  assertPathInside(outputDir, packagePath);

  await createVSIX({
    cwd: extensionRoot,
    packagePath,
    readmePath: "README.md",
    dependencies: false,
    allowMissingRepository: true,
    rewriteRelativeLinks: false,
    skipLicense: true,
    preRelease: true,
  });

  const packageInfo = await readVSIXPackage(packagePath);
  assertPackagedManifest(packageInfo, manifest);

  const checksum = await sha256File(packagePath);
  const checksumPath = `${packagePath}.sha256`;
  await fs.writeFile(checksumPath, `${checksum}  ${path.basename(packagePath)}\n`, "utf8");

  const stats = await fs.stat(packagePath);
  const relativePackagePath = path.relative(workspaceRoot, packagePath);
  const relativeChecksumPath = path.relative(workspaceRoot, checksumPath);
  console.log(`VSIX ${releaseChannel} package created: ${relativePackagePath}`);
  console.log(`SHA-256 checksum written: ${relativeChecksumPath}`);
  console.log(`Package size: ${stats.size} bytes`);
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function assertAlphaManifestShape(manifest) {
  assert(typeof manifest.name === "string" && manifest.name.length > 0, "package.json must define name.");
  assert(typeof manifest.version === "string" && manifest.version.length > 0, "package.json must define version.");
  assert(typeof manifest.publisher === "string" && manifest.publisher.length > 0, "package.json must define publisher.");
  assert(typeof manifest.engines?.vscode === "string", "package.json must define engines.vscode.");
  assert(
    typeof manifest.main === "string" && normalizeManifestPath(manifest.main).startsWith("out/"),
    'package.json main must point at compiled "out/" JavaScript.',
  );
  assert(
    Array.isArray(manifest.activationEvents) && manifest.activationEvents.includes("onView:prole-coder.chat"),
    "activationEvents must include onView:prole-coder.chat.",
  );
  assert(
    manifest.activationEvents.includes("onChatParticipant:prole-coder.chatParticipant"),
    "activationEvents must include onChatParticipant:prole-coder.chatParticipant.",
  );
  const chatParticipant = manifest.contributes?.chatParticipants?.find(
    (participant) => participant?.id === "prole-coder.chatParticipant",
  );
  assert(chatParticipant?.name === "prole", "native chat participant @prole must be declared.");
}

function assertPackagedManifest(packageInfo, sourceManifest) {
  const packagedManifest = packageInfo?.manifest;
  assert(packagedManifest?.name === sourceManifest.name, "VSIX package name does not match package.json.");
  assert(packagedManifest?.version === sourceManifest.version, "VSIX package version does not match package.json.");
  assert(packagedManifest?.publisher === sourceManifest.publisher, "VSIX publisher does not match package.json.");

  const properties = packageInfo?.xmlManifest?.PackageManifest?.Metadata?.[0]?.Properties?.[0]?.Property ?? [];
  const hasPreReleaseFlag = properties.some(
    (property) =>
      property?.$?.Id === "Microsoft.VisualStudio.Code.PreRelease" && property?.$?.Value === "true",
  );
  assert(hasPreReleaseFlag, "VSIX manifest must be marked as a VS Code pre-release package.");
}

async function sha256File(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeManifestPath(manifestPath) {
  return manifestPath.replace(/^\.\//u, "").replaceAll("\\", "/");
}

function assertPathInside(parent, child) {
  const relative = path.relative(parent, child);
  assert(relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative), `${child} is outside ${parent}.`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
