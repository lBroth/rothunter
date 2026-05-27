import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectProducerConsumerFieldDrift } from '../detectors/producer-consumer-field-drift.js';

function setup(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-pcfd-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

function run(root: string, files: string[]) {
  return detectProducerConsumerFieldDrift({ workspaceRoot: root, files });
}

describe('producer-consumer-field-drift detector', () => {
  it('flags a server that reads a field no client ever sends', async () => {
    const root = setup({
      'src/server.ts':
        "app.post('/api/users', (req, res) => {\n" +
        '  const { email, displayName, role } = req.body;\n' +
        '  void email; void displayName; void role;\n' +
        '  res.json({ ok: true });\n' +
        '});\n',
      'src/client.ts':
        "fetch('/api/users', { method: 'POST', body: JSON.stringify({ email: 'a@b', displayName: 'A' }) });\n",
    });
    try {
      const findings = run(root, ['src/server.ts', 'src/client.ts']);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe('high');
      expect(findings[0]!.title).toContain('POST /api/users');
      expect(findings[0]!.description).toContain('role');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag when every server-read field is in the client body', async () => {
    const root = setup({
      'src/server.ts':
        "app.post('/api/users', (req, res) => {\n" +
        '  const { email, displayName } = req.body;\n' +
        '  void email; void displayName;\n' +
        '});\n',
      'src/client.ts':
        "fetch('/api/users', { method: 'POST', body: JSON.stringify({ email: 'a@b', displayName: 'A', extra: 1 }) });\n",
    });
    try {
      const findings = run(root, ['src/server.ts', 'src/client.ts']);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a server route when no client sends to it (cannot make a claim)', async () => {
    const root = setup({
      'src/server.ts':
        "app.post('/api/orphan', (req, res) => {\n" +
        '  const { foo } = req.body;\n' +
        '  void foo;\n' +
        '});\n',
    });
    try {
      const findings = run(root, ['src/server.ts']);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('matches req.body dot-access (not just destructuring)', async () => {
    const root = setup({
      'src/server.ts':
        "router.put('/api/profile', (req, res) => {\n" +
        '  const name = req.body.userName;\n' +
        '  const email = req.body.contact;\n' +
        '  void name; void email;\n' +
        '});\n',
      'src/client.ts':
        "fetch('/api/profile', { method: 'PUT', body: JSON.stringify({ userName: 'A' }) });\n",
    });
    try {
      const findings = run(root, ['src/server.ts', 'src/client.ts']);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.description).toContain('contact');
      expect(findings[0]!.description).not.toContain('userName');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('separates GET / POST on the same path', async () => {
    const root = setup({
      'src/server.ts':
        "app.get('/api/x', (req, res) => { const { q } = req.query; void q; });\n" +
        "app.post('/api/x', (req, res) => { const { a, b } = req.body; void a; void b; });\n",
      'src/client.ts':
        "fetch('/api/x', { method: 'POST', body: JSON.stringify({ a: 1 }) });\n" +
        "fetch('/api/x?q=1', { method: 'GET' });\n",
    });
    try {
      const findings = run(root, ['src/server.ts', 'src/client.ts']);
      // The POST handler reads `b` but the client only sends `a`. GET
      // is not flagged: the URL on the client has `?q=1` and we don't
      // analyse GET bodies anyway.
      const post = findings.find((f) => f.title.includes('POST /api/x'));
      expect(post).toBeDefined();
      expect(post!.description).toContain('`b`');
      expect(post!.description).not.toContain('`a`');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles axios.post('/url', { ... })", async () => {
    const root = setup({
      'src/server.ts':
        "app.post('/api/items', (req, res) => { const { sku, qty } = req.body; void sku; void qty; });\n",
      'src/client.ts': "axios.post('/api/items', { sku: 'X' });\n",
    });
    try {
      const findings = run(root, ['src/server.ts', 'src/client.ts']);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.description).toContain('qty');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles template-string URLs by their literal prefix', async () => {
    const root = setup({
      'src/server.ts':
        "app.post('/api/users/', (req, res) => { const { tag, who } = req.body; void tag; void who; });\n",
      'src/client.ts':
        "const id = '42';\n" +
        "fetch(`/api/users/${id}`, { method: 'POST', body: JSON.stringify({ tag: 'x' }) });\n",
    });
    try {
      // Server URL `/api/users/` and client template prefix `/api/users/`
      // should match after trailing-slash normalisation; server reads
      // both `tag` and `who`, client sends only `tag`.
      const findings = run(root, ['src/server.ts', 'src/client.ts']);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.description).toContain('who');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('respects the rothunter:ignore-producer-consumer-field-drift annotation', async () => {
    const root = setup({
      'src/server.ts':
        '// rothunter:ignore-producer-consumer-field-drift\n' +
        "app.post('/api/users', (req, res) => { const { a, b } = req.body; void a; void b; });\n",
      'src/client.ts': "fetch('/api/users', { method: 'POST', body: JSON.stringify({ a: 1 }) });\n",
    });
    try {
      const findings = run(root, ['src/server.ts', 'src/client.ts']);
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('produces a stable fingerprint', async () => {
    const root = setup({
      'src/server.ts':
        "app.post('/api/users', (req, res) => { const { a, b } = req.body; void a; void b; });\n",
      'src/client.ts': "fetch('/api/users', { method: 'POST', body: JSON.stringify({ a: 1 }) });\n",
    });
    try {
      const a = run(root, ['src/server.ts', 'src/client.ts']);
      const b = run(root, ['src/server.ts', 'src/client.ts']);
      expect(a[0]!.fingerprint).toBe(b[0]!.fingerprint);
      expect(a[0]!.fingerprint).toMatch(/^producer-consumer-field-drift:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
