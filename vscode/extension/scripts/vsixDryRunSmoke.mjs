#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createVSIX } = require("@vscode/vsce");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const workspaceRoot = path.resolve(extensionRoot, "..", "..");
const targetRoot = path.join(workspaceRoot, "target");

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const manifestPath = path.join(extensionRoot, "package.json");
  const manifest = await readJson(manifestPath);

  await assertManifestPackagingShape(manifest);
  await assertVscodeIgnore();
  await assertWorkspaceDependencyBoundary(manifest);

  await fs.mkdir(targetRoot, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(targetRoot, "vsix-dry-run-"));
  const packagePath = path.join(tempDir, `${manifest.name}-${manifest.version}.vsix`);

  try {
    await createVSIX({
      cwd: extensionRoot,
      packagePath,
      readmePath: "README.md",
      dependencies: false,
      allowMissingRepository: true,
      rewriteRelativeLinks: false,
      skipLicense: true,
    });

    const entries = await readZipEntries(packagePath);
    assertPackageEntries(entries, manifest);

    console.log(`VSIX dry-run packaging smoke passed (${entries.size} entries inspected).`);
  } finally {
    await removeTempDir(tempDir);
  }
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function assertManifestPackagingShape(manifest) {
  assert(typeof manifest.name === "string" && manifest.name.length > 0, "package.json must define name.");
  assert(
    typeof manifest.version === "string" && manifest.version.length > 0,
    "package.json must define version.",
  );
  assert(
    typeof manifest.main === "string" && normalizeManifestPath(manifest.main).startsWith("out/"),
    'package.json main must point at compiled "out/" JavaScript.',
  );
  await assertFileExists(path.join(extensionRoot, manifest.main), `compiled entry ${manifest.main}`);

  const activationEvents = manifest.activationEvents;
  assert(Array.isArray(activationEvents) && activationEvents.length > 0, "activationEvents must not be empty.");
  assert(!activationEvents.includes("*"), "activationEvents must be explicit for the smoke package.");
  for (const event of ["onCommand:prole-coder.openChat", "onView:prole-coder.chat"]) {
    assert(activationEvents.includes(event), `activationEvents must include ${event}.`);
  }
  assert(
    activationEvents.includes("onChatParticipant:prole-coder.chatParticipant"),
    "activationEvents must include onChatParticipant:prole-coder.chatParticipant.",
  );

  const chatParticipant = manifest.contributes?.chatParticipants?.find(
    (participant) => participant?.id === "prole-coder.chatParticipant",
  );
  assert(chatParticipant?.name === "prole", "native chat participant @prole must be declared.");
  assert(chatParticipant?.isSticky === true, "native chat participant must be sticky.");

  const iconPath = manifest.contributes?.viewsContainers?.activitybar?.find(
    (container) => container?.id === "prole-coder",
  )?.icon;
  assert(typeof iconPath === "string" && iconPath.length > 0, "activity bar icon must be declared.");
  await assertFileExists(path.join(extensionRoot, iconPath), `activity bar icon ${iconPath}`);
}

async function assertVscodeIgnore() {
  const ignorePath = path.join(extensionRoot, ".vscodeignore");
  await assertFileExists(ignorePath, ".vscodeignore");
  const ignoreLines = new Set(
    (await fs.readFile(ignorePath, "utf8"))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );

  for (const pattern of ["src/**", "test/**", "scripts/**", "out-test/**", "node_modules/**", "**/*.map"]) {
    assert(ignoreLines.has(pattern), `.vscodeignore must contain ${pattern}.`);
  }
}

async function assertWorkspaceDependencyBoundary(manifest) {
  const runtimeDependencySections = ["dependencies", "optionalDependencies"];
  for (const section of runtimeDependencySections) {
    const dependencies = manifest[section] ?? {};
    for (const [name, version] of Object.entries(dependencies)) {
      assert(
        typeof version !== "string" || !version.startsWith("workspace:"),
        `${section}.${name} must not use workspace:* in the VSIX runtime package.`,
      );
    }
  }

  const workspaceDevDependencies = Object.entries(manifest.devDependencies ?? {}).filter(
    ([, version]) => typeof version === "string" && version.startsWith("workspace:"),
  );
  assert(
    workspaceDevDependencies.some(([name]) => name === "@prole-coder/protocol"),
    "expected @prole-coder/protocol to remain an explicit workspace:* devDependency.",
  );

  const compiledFiles = await collectFiles(path.join(extensionRoot, "out"));
  const jsFiles = compiledFiles.filter((filePath) => /\.(?:cjs|js|mjs)$/u.test(filePath));
  for (const filePath of jsFiles) {
    const content = await fs.readFile(filePath, "utf8");
    for (const [packageName] of workspaceDevDependencies) {
      assert(
        !content.includes(packageName),
        `compiled runtime file ${path.relative(extensionRoot, filePath)} still references ${packageName}.`,
      );
    }
  }
}

function assertPackageEntries(entries, manifest) {
  const requiredEntries = [
    "extension/package.json",
    `extension/${normalizeManifestPath(manifest.main)}`,
    "extension/media/prole-coder-view.svg",
    "extension/readme.md",
  ];

  for (const entry of requiredEntries) {
    assert(entries.has(entry), `VSIX package must include ${entry}.`);
  }

  const forbiddenPrefixes = [
    "extension/src/",
    "extension/test/",
    "extension/scripts/",
    "extension/out-test/",
    "extension/node_modules/",
    "extension/.vscode/",
  ];
  for (const entry of entries) {
    for (const prefix of forbiddenPrefixes) {
      assert(!entry.startsWith(prefix), `VSIX package must not include ignored path ${entry}.`);
    }
    assert(!entry.endsWith(".map"), `VSIX package must not include source map ${entry}.`);
    assert(!entry.endsWith(".tsbuildinfo"), `VSIX package must not include TypeScript build info ${entry}.`);
  }
}

async function assertFileExists(filePath, label) {
  try {
    const stat = await fs.stat(filePath);
    assert(stat.isFile(), `${label} must be a file.`);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Missing ${label}.`);
    }
    throw error;
  }
}

async function collectFiles(root) {
  const files = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function readZipEntries(zipPath) {
  const buffer = await fs.readFile(zipPath);
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  const entries = new Set();

  let offset = centralDirectoryOffset;
  while (offset < centralDirectoryEnd) {
    assert(buffer.readUInt32LE(offset) === 0x02014b50, "Invalid VSIX central directory.");
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    entries.add(buffer.toString("utf8", fileNameStart, fileNameEnd));
    offset = fileNameEnd + extraFieldLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const minimumOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) {
      return offset;
    }
  }
  throw new Error("Invalid VSIX: missing ZIP end of central directory.");
}

function normalizeManifestPath(manifestPath) {
  return manifestPath.replace(/^\.\//u, "").replaceAll("\\", "/");
}

async function removeTempDir(tempDir) {
  assertPathInside(targetRoot, tempDir);
  await fs.rm(tempDir, { recursive: true, force: true });
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
