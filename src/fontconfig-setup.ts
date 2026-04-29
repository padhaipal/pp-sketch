// Make the bundled Noto Sans Devanagari fonts visible to fontconfig (and
// therefore to sharp/librsvg/Pango when we render the report-card SVG → PNG).
// Must be imported BEFORE anything that loads `sharp`, otherwise sharp's
// fontconfig instance has already cached its discovery paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fontsDir = path.resolve(__dirname, 'assets', 'fonts');
const cacheDir = path.join(os.tmpdir(), 'pp-sketch-fontconfig-cache');
const confDir = path.join(os.tmpdir(), 'pp-sketch-fontconfig');
const confPath = path.join(confDir, 'fonts.conf');

// Layer our font dir on top of the system defaults via <include>. Skipping the
// DOCTYPE because some bundled fontconfigs (sharp's libvips on Linux) trip on
// the DTD lookup.
const conf = `<?xml version="1.0"?>
<fontconfig>
  <dir>${fontsDir}</dir>
  <dir>/usr/share/fonts</dir>
  <dir>/usr/local/share/fonts</dir>
  <cachedir>${cacheDir}</cachedir>
</fontconfig>
`;

fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(confDir, { recursive: true });
fs.writeFileSync(confPath, conf);

// Set BOTH — different fontconfig builds prefer one or the other.
process.env.FONTCONFIG_FILE = confPath;
process.env.FONTCONFIG_PATH = confDir;

// Belt-and-suspenders: also drop a copy in $HOME/.fonts/, which fontconfig
// scans by default in most builds. Cheap (<1 MB) and means we don't depend on
// the bundled libvips honoring env vars.
const home = process.env.HOME ?? os.homedir();
const homeFontsDir = path.join(home, '.fonts');
try {
  fs.mkdirSync(homeFontsDir, { recursive: true });
  for (const file of fs.readdirSync(fontsDir)) {
    if (!file.endsWith('.ttf')) continue;
    const dst = path.join(homeFontsDir, file);
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(path.join(fontsDir, file), dst);
    }
  }
} catch (err) {
  // Non-fatal — the FONTCONFIG_FILE path may still work.
  console.error(`[fontconfig-setup] failed to populate ${homeFontsDir}:`, err);
}

// Boot-time diagnostics — verify the paths exist and list the font files we
// shipped. Goes out via stderr (Railway picks it up).
const fontsExist = fs.existsSync(fontsDir);
const fontFiles = fontsExist
  ? fs.readdirSync(fontsDir).filter((f) => f.endsWith('.ttf'))
  : [];
console.log(
  `[fontconfig-setup] FONTCONFIG_FILE=${confPath} ` +
    `fontsDir=${fontsDir} exists=${fontsExist} ` +
    `files=${JSON.stringify(fontFiles)} ` +
    `homeFontsDir=${homeFontsDir}`,
);
