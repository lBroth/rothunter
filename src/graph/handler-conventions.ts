import * as path from 'node:path';

// Files in dirs where runtimes load handlers via explicit config (CDK/SAM/SST,
// netlify.toml, serverless): src/handlers, src/lambdas, src/functions, netlify/
// functions, etc. Auto-routed paths (pages/api, app/api/.../route) excluded —
// those are wired by filesystem convention, handled by entry-points.ts.

const HANDLER_DIR_PATTERNS: RegExp[] = [
  /(^|\/)src\/handlers\//,
  /(^|\/)src\/lambdas?\//,
  /(^|\/)src\/functions\//,
  /(^|\/)handlers\//,
  /(^|\/)lambdas?\//,
  /(^|\/)functions\//,
  /(^|\/)netlify\/(functions|edge-functions)\//,
];

export function isHandlerConventionFile(file: string): boolean {
  const posix = file.split(path.sep).join('/');
  // Skip ambient declarations / story files — never handlers.
  if (/\.d\.ts$/.test(posix)) return false;
  if (/\.(test|spec)\.(ts|tsx)$/.test(posix)) return false;
  if (!/\.(ts|tsx)$/.test(posix)) return false;
  return HANDLER_DIR_PATTERNS.some((re) => re.test(posix));
}
