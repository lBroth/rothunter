import * as path from 'node:path';

/**
 * "Handler-convention" file detection.
 *
 * These are workspace-relative file paths that live in directories where a
 * runtime (AWS Lambda, Netlify Functions, etc.) loads handlers by explicit
 * configuration — NOT by file-system convention alone.
 *
 *   src/handlers/foo.ts          ← AWS-style, requires CDK / SAM / SST wiring
 *   src/lambdas/foo.ts           ← AWS-style alias
 *   src/functions/foo.ts         ← serverless-framework, GCP CF, Azure FN
 *   handlers/foo.ts              ← root-level variants of the above
 *   netlify/functions/foo.ts     ← Netlify, wired via netlify.toml
 *   netlify/edge-functions/x.ts  ← Netlify edge, same wiring story
 *
 * Importantly we EXCLUDE framework auto-routed paths (pages/api/,
 * app/api/[segment]/route.ts, root-level api/*.ts, Cloudflare worker.ts,
 * etc.). Those are wired by file-path convention; presence of the file is
 * the wiring. entry-points.ts already protects them; flagging them as
 * dead handlers would be a false positive.
 *
 * The result: a precise predicate the dead-handler detector can use to
 * decide whether a file is "supposed to be wired explicitly". If it is,
 * the detector then checks whether any IaC construct (or static import)
 * actually points at it.
 */

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
