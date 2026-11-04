// Koffi's optional npm packages follow the build host's architecture. Supply
// the target addon explicitly so cross-built apps do not silently lose hotkeys.
const { readFile, writeFile, mkdir, mkdtemp, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { Arch } = require('builder-util');
const tar = require('tar');

function assertMachOArchitecture(data, arch) {
  const expected = arch === 'arm64' ? 0x0100000c : 0x01000007;
  if (data.length < 32) throw new Error('The Koffi native addon is truncated.');
  if (data.readUInt32LE(0) === 0xfeedfacf && data.readUInt32LE(4) === expected) return;
  const magic = data.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = data.readUInt32BE(4);
    const stride = magic === 0xcafebabf ? 32 : 20;
    if (count < 64 && 8 + count * stride <= data.length) {
      for (let i = 0; i < count; i++) if (data.readUInt32BE(8 + i * stride) === expected) return;
    }
  }
  throw new Error(`The Koffi native addon does not contain the requested ${arch} architecture.`);
}

async function lockedAddon(projectDir, arch) {
  const name = `@koromix/koffi-darwin-${arch}`;
  const relativeBinary = `darwin_${arch}/koffi.node`;
  const koffi = JSON.parse(await readFile(join(projectDir, 'node_modules/koffi/package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(projectDir, 'package-lock.json'), 'utf8'));
  const locked = lock.packages?.[`node_modules/${name}`];
  if (!locked || locked.version !== koffi.version || !locked.integrity?.startsWith('sha512-')) {
    throw new Error(`Missing matching locked ${name} dependency. Run npm install with the current package.json and retry.`);
  }

  try {
    const installed = JSON.parse(await readFile(join(projectDir, 'node_modules', name, 'package.json'), 'utf8'));
    if (installed.name === name && installed.version === locked.version) {
      const data = await readFile(join(projectDir, 'node_modules', name, relativeBinary));
      assertMachOArchitecture(data, arch);
      return data;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const url = new URL(locked.resolved);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('The locked native dependency must use an HTTPS URL without credentials.');
  console.log(`Preparing locked ${name}@${locked.version} for the ${arch} app…`);
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error(`Cannot download ${name}: HTTP ${response.status}. Retry with network access or build on matching hardware.`);
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.byteLength;
    if (size > 20 * 1024 * 1024) throw new Error('Native dependency archive exceeded the 20 MB limit.');
    parts.push(part);
  }
  const archive = Buffer.concat(parts);
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  if (integrity !== locked.integrity) throw new Error(`Integrity verification failed for ${name}; refusing to package it.`);

  const temporary = await mkdtemp(join(tmpdir(), 'peek-native-'));
  try {
    const file = join(temporary, 'native.tgz');
    await writeFile(file, archive);
    // Extract only the expected regular file; never run npm lifecycle scripts,
    // follow archive symlinks, or change package.json/package-lock/node_modules.
    await tar.x({ file, cwd: temporary, strip: 1, strict: true,
      filter: (name, entry) => name === `package/${relativeBinary}` && entry.type === 'File' });
    const data = await readFile(join(temporary, relativeBinary));
    assertMachOArchitecture(data, arch);
    return data;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = Arch[context.arch];
  if (arch !== 'arm64' && arch !== 'x64') throw new Error('Build separate arm64 and x64 Peek packages; universal packaging is not configured.');
  const binary = await lockedAddon(context.packager.projectDir, arch);
  const destination = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents/Resources/koffi', `darwin_${arch}`);
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'koffi.node'), binary, { mode: 0o755 });
  console.log(`Verified ${arch} Koffi addon included in app resources.`);
};
