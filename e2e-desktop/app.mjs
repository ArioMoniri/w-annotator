import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const exe = process.platform === 'win32' ? '.exe' : '';

/** The debug build made by `pnpm tauri build --debug --no-bundle`, or the binary named in W_APP. */
export const APP = resolve(process.env.W_APP ?? join(here, '..', 'target', 'debug', `w-annotator${exe}`));
