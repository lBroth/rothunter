import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectDeadEndpoints } from '../detectors/dead-endpoint.js';

function setup(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-deadep-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

function run(root: string, files: string[]) {
  return detectDeadEndpoints({ workspaceRoot: root, files });
}

describe('dead-endpoint detector', () => {
  it('flags a route with no client callsite anywhere in the workspace', async () => {
    const root = setup({
      'src/server.ts': "app.post('/api/orphan', (req, res) => { res.json({ ok: true }); });\n",
      'src/client.ts': "fetch('/api/used', { method: 'POST' });\n",
    });
    try {
      const findings = run(root, ['src/server.ts', 'src/client.ts']);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe('medium');
      expect(findings[0]!.title).toContain('POST /api/orphan');
      expect(findings[0]!.fingerprint).toMatch(/^dead-endpoint:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a route with at least one matching client', async () => {
    const root = setup({
      'src/server.ts': "router.put('/api/items', (req, res) => { res.json({}); });\n",
      'src/client.ts':
        "fetch('/api/items', { method: 'PUT', body: JSON.stringify({ sku: 'x' }) });\n",
    });
    try {
      const findings = run(root, ['src/server.ts', 'src/client.ts']);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keys endpoints by METHOD + url — same path under different methods is distinct', async () => {
    const root = setup({
      'src/server.ts':
        "app.get('/api/x', (req, res) => { res.json({}); });\n" +
        "app.post('/api/x', (req, res) => { res.json({}); });\n",
      'src/client.ts':
        // Only the POST is called.
        "fetch('/api/x', { method: 'POST', body: JSON.stringify({}) });\n",
    });
    try {
      const findings = run(root, ['src/server.ts', 'src/client.ts']);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.title).toContain('GET /api/x');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats a fetch without explicit method as GET', async () => {
    const root = setup({
      'src/server.ts': "app.get('/api/health', (req, res) => { res.json({}); });\n",
      'src/client.ts': "fetch('/api/health');\n",
    });
    try {
      const findings = run(root, ['src/server.ts', 'src/client.ts']);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('matches template-string client URL against a parametrised server route', async () => {
    const root = setup({
      'src/server.ts': "app.get('/api/users/:id', (req, res) => { res.json({}); });\n",
      'src/client.ts': 'const id = 1;\nfetch(`/api/users/${id}`);\n',
    });
    try {
      const findings = run(root, ['src/server.ts', 'src/client.ts']);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles axios.<method>(url) callsites', async () => {
    const root = setup({
      'src/server.ts': "app.post('/api/charge', (req, res) => { res.json({}); });\n",
      'src/client.ts': "axios.post('/api/charge', { amount: 100 });\n",
    });
    try {
      const findings = run(root, ['src/server.ts', 'src/client.ts']);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles axios({ method, url }) bare form', async () => {
    const root = setup({
      'src/server.ts': "app.delete('/api/cart', (req, res) => { res.json({}); });\n",
      'src/client.ts': "axios({ method: 'DELETE', url: '/api/cart' });\n",
    });
    try {
      const findings = run(root, ['src/server.ts', 'src/client.ts']);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cross-workspace: route in service A is called from service B (flat file list)', async () => {
    const root = setup({
      'services/merchants/src/server.ts':
        "app.get('/api/merchants', (req, res) => { res.json([]); });\n",
      'services/orders/src/client.ts': "fetch('/api/merchants');\n",
    });
    try {
      const findings = run(root, [
        'services/merchants/src/server.ts',
        'services/orders/src/client.ts',
      ]);
      // The detector treats the full files[] array as one bucket — exactly
      // how multi-workspace-scanner shapes its input.
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns no findings when there are no server routes at all', async () => {
    const root = setup({
      'src/client.ts': "fetch('/api/x');\n",
    });
    try {
      const findings = run(root, ['src/client.ts']);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('respects rothunter:ignore-dead-endpoint annotation', async () => {
    const root = setup({
      'src/server.ts':
        '// rothunter:ignore-dead-endpoint\n' +
        "app.post('/api/external', (req, res) => { res.json({ ok: true }); });\n",
    });
    try {
      const findings = run(root, ['src/server.ts']);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('tolerates trailing-slash mismatches between server route and client URL', async () => {
    const root = setup({
      'src/server.ts': "app.post('/api/widgets/', (req, res) => { res.json({}); });\n",
      'src/client.ts': "fetch('/api/widgets', { method: 'POST' });\n",
    });
    try {
      const findings = run(root, ['src/server.ts', 'src/client.ts']);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits a stable fingerprint per (file, line, endpoint)', async () => {
    const root = setup({
      'src/server.ts': "app.post('/api/orphan', (req, res) => { res.json({ ok: true }); });\n",
    });
    try {
      const a = run(root, ['src/server.ts']);
      const b = run(root, ['src/server.ts']);
      expect(a[0]!.fingerprint).toBe(b[0]!.fingerprint);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags multiple orphan routes in the same file', async () => {
    const root = setup({
      'src/server.ts':
        "app.post('/api/a', (req, res) => { res.json({}); });\n" +
        "app.delete('/api/b', (req, res) => { res.json({}); });\n" +
        "app.get('/api/c', (req, res) => { res.json({}); });\n",
      'src/client.ts': "fetch('/api/c');\n",
    });
    try {
      const findings = run(root, ['src/server.ts', 'src/client.ts']);
      expect(findings).toHaveLength(2);
      const titles = findings.map((f) => f.title);
      expect(titles.some((t) => t.includes('POST /api/a'))).toBe(true);
      expect(titles.some((t) => t.includes('DELETE /api/b'))).toBe(true);
      expect(titles.some((t) => t.includes('GET /api/c'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
