import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';

/**
 * Runs the Nest CLI with a PATH that works.
 *
 * On this machine C:\Windows\System32 is missing from PATH, and the Nest CLI
 * stops the previous server by shelling out to `taskkill` (see
 * @nestjs/cli/lib/utils/tree-kill.js). Without it every file change throws
 * before the old process is stopped: the CLI dies, nothing reloads, and the
 * orphaned `dist/main` keeps the port, so restarts pile up duplicate servers.
 */
if (process.platform === 'win32') {
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const parts = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  if (!parts.includes(system32)) {
    process.env.PATH = [system32, ...parts].join(delimiter);
  }
}

const nest = join(import.meta.dirname, '..', 'node_modules', '@nestjs', 'cli', 'bin', 'nest.js');
const child = spawn(process.execPath, [nest, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
