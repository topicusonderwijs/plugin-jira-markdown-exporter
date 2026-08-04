/*
 * build.mjs — produce per-browser packages in dist/.
 *
 * The repo's manifest.json declares both `background.service_worker` (Chrome)
 * and `background.scripts` (Firefox) so the folder can be loaded unpacked in
 * either browser. Each browser ignores the other's key, but only after logging
 * a manifest warning — so for store uploads we strip the key that doesn't
 * apply, and drop `browser_specific_settings` from the Chrome build.
 *
 * Usage: node scripts/build.mjs [chrome|firefox]   (default: both)
 * No dependencies. Zips are produced with the system `zip` when available.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const ASSETS = ['src', 'icons', 'LICENSE', 'PRIVACY.md'];

const TARGETS = {
  chrome(manifest) {
    delete manifest.background.scripts;
    delete manifest.browser_specific_settings;
    return manifest;
  },
  firefox(manifest) {
    delete manifest.background.service_worker;
    return manifest;
  },
};

async function build(target) {
  const outDir = join(DIST, target);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const manifest = TARGETS[target](JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8')));
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const asset of ASSETS) {
    await cp(join(ROOT, asset), join(outDir, asset), { recursive: true });
  }

  const zip = join(DIST, `${target}-${manifest.version}.zip`);
  await rm(zip, { force: true });
  const res = spawnSync('zip', ['-qr', zip, '.'], { cwd: outDir });
  if (res.error || res.status !== 0) {
    console.log(`✓ dist/${target}/ (install \`zip\` to also produce the .zip)`);
  } else {
    console.log(`✓ dist/${target}/ and dist/${target}-${manifest.version}.zip`);
  }
}

const requested = process.argv[2];
if (requested && !TARGETS[requested]) {
  console.error(`Unknown target "${requested}". Use: chrome | firefox`);
  process.exit(1);
}
for (const target of requested ? [requested] : Object.keys(TARGETS)) {
  await build(target);
}
