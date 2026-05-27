import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectUnsanitizedInputToSink } from '../detectors/unsanitized-input-to-sink.js';

function setup(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-taint-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

function run(root: string, files: string[]) {
  return detectUnsanitizedInputToSink({ workspaceRoot: root, files });
}

describe('unsanitized-input-to-sink detector', () => {
  it('flags req.body interpolated into a raw SQL `db.query` call', async () => {
    const root = setup({
      'src/handler.ts':
        "app.post('/u', (req, res) => {\n" +
        '  const userId = req.body.userId;\n' +
        '  db.query(`SELECT * FROM users WHERE id = ${userId}`);\n' +
        '});\n',
    });
    try {
      const findings = run(root, ['src/handler.ts']);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe('high');
      expect(findings[0]!.title).toContain('userId');
      expect(findings[0]!.title).toContain('raw SQL');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags req.body destructured then concatenated into exec()', async () => {
    const root = setup({
      'src/handler.ts':
        "import { exec } from 'child_process';\n" +
        "app.post('/run', (req, res) => {\n" +
        '  const { cmd } = req.body;\n' +
        "  exec('ls ' + cmd, (e, out) => { void e; void out; });\n" +
        '});\n',
    });
    try {
      const findings = run(root, ['src/handler.ts']);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.title).toContain('cmd');
      expect(findings[0]!.title).toContain('exec');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags req.params interpolated into fs.readFile path', async () => {
    const root = setup({
      'src/handler.ts':
        "import * as fs from 'fs';\n" +
        "app.get('/file', (req, res) => {\n" +
        '  const file = req.params.name;\n' +
        '  fs.readFile(`/var/data/${file}`, (e, b) => { void e; void b; });\n' +
        '});\n',
    });
    try {
      const findings = run(root, ['src/handler.ts']);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.title).toContain('file');
      expect(findings[0]!.title).toContain('fs path');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags eval() with a tainted argument', async () => {
    const root = setup({
      'src/handler.ts':
        "app.post('/x', (req, res) => {\n" +
        '  const code = req.body.code;\n' +
        '  eval(`return ${code}`);\n' +
        '});\n',
    });
    try {
      const findings = run(root, ['src/handler.ts']);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.title).toContain('eval');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags a tagged SQL template with a tainted interpolation', async () => {
    const root = setup({
      'src/handler.ts':
        "app.post('/u', (req, res) => {\n" +
        '  const id = req.body.id;\n' +
        '  const result = sql`SELECT * FROM users WHERE id = ${id}`;\n' +
        '  void result;\n' +
        '});\n',
    });
    try {
      const findings = run(root, ['src/handler.ts']);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.title).toContain('tagged-template');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags searchParams.get value reaching a sink', async () => {
    const root = setup({
      'src/route.ts':
        "export async function GET(request: Request) {\n" +
        '  const searchParams = new URL(request.url).searchParams;\n' +
        "  const q = searchParams.get('q');\n" +
        '  return db.query(`SELECT * FROM items WHERE name LIKE ${q}`);\n' +
        '}\n',
    });
    try {
      const findings = run(root, ['src/route.ts']);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.title).toContain('q');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag when the tainted value passes through a parser first', async () => {
    const root = setup({
      'src/handler.ts':
        "app.post('/u', (req, res) => {\n" +
        '  const raw = req.body.userId;\n' +
        '  const userId = parseUserId(raw); // re-bound name — detector loses taint, as designed\n' +
        '  db.query(`SELECT * FROM users WHERE id = ${userId}`);\n' +
        '});\n',
    });
    try {
      // `userId` is bound from `parseUserId(raw)`, not directly from
      // req.body — the detector tracks taint only on the immediate
      // bind site, so this stays quiet. Documented limitation: an
      // operator can defeat the heuristic by re-binding.
      const findings = run(root, ['src/handler.ts']);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a sink call that uses no tainted name', async () => {
    const root = setup({
      'src/handler.ts':
        "app.get('/static', (req, res) => {\n" +
        "  db.query('SELECT * FROM users WHERE id = 1');\n" +
        '});\n',
    });
    try {
      const findings = run(root, ['src/handler.ts']);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a tainted variable passed to a non-sink helper', async () => {
    const root = setup({
      'src/handler.ts':
        "app.post('/u', (req, res) => {\n" +
        '  const userId = req.body.userId;\n' +
        '  console.log(`got user ${userId}`);\n' +
        '});\n',
    });
    try {
      const findings = run(root, ['src/handler.ts']);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('respects the rothunter:ignore-unsanitized-input-to-sink annotation', async () => {
    const root = setup({
      'src/handler.ts':
        "app.post('/u', (req, res) => {\n" +
        '  const userId = req.body.userId;\n' +
        '  // rothunter:ignore-unsanitized-input-to-sink\n' +
        '  db.query(`SELECT * FROM users WHERE id = ${userId}`);\n' +
        '});\n',
    });
    try {
      const findings = run(root, ['src/handler.ts']);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('produces a stable fingerprint', async () => {
    const root = setup({
      'src/handler.ts':
        "app.post('/u', (req, res) => {\n" +
        '  const userId = req.body.userId;\n' +
        '  db.query(`SELECT * FROM users WHERE id = ${userId}`);\n' +
        '});\n',
    });
    try {
      const a = run(root, ['src/handler.ts']);
      const b = run(root, ['src/handler.ts']);
      expect(a[0]!.fingerprint).toBe(b[0]!.fingerprint);
      expect(a[0]!.fingerprint).toMatch(/^unsanitized-input-to-sink:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
