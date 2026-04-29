// Make the bundled Noto Sans Devanagari fonts visible to fontconfig (and
// therefore to sharp/librsvg/Pango when we render the report-card SVG → PNG).
// Must be imported BEFORE anything that loads `sharp`, otherwise sharp's
// fontconfig instance has already cached the discovery paths.
//
// Strategy: write a single fonts.conf to a temp dir that points at our
// `assets/fonts/` directory (resolved relative to the compiled main.ts so it
// works in both `nest start` (src) and `node dist/main` (dist)). Then point
// fontconfig at it via FONTCONFIG_FILE.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fontsDir = path.resolve(__dirname, 'assets', 'fonts');
const cacheDir = path.join(os.tmpdir(), 'pp-sketch-fontconfig-cache');
const confPath = path.join(os.tmpdir(), 'pp-sketch-fonts.conf');

const conf = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontsDir}</dir>
  <dir>/usr/share/fonts</dir>
  <dir>/usr/local/share/fonts</dir>
  <cachedir>${cacheDir}</cachedir>
</fontconfig>
`;

fs.mkdirSync(cacheDir, { recursive: true });
fs.writeFileSync(confPath, conf);

process.env.FONTCONFIG_FILE = confPath;
