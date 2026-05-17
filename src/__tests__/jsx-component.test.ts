import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RotHunter } from '../rothunter.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-jsx-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('JSX / React component duplication', () => {
  it('detects two duplicate React functional components (arrow form) across files', async () => {
    const root = await setup({
      'src/components/Primary.tsx': `
import React from 'react';
export const PrimaryButton = ({ label }: { label: string }): JSX.Element => {
  return <button className="btn btn-primary">{label}</button>;
};
`,
      'src/components/Hero.tsx': `
import React from 'react';
export const HeroButton = ({ label }: { label: string }): JSX.Element => {
  return <button className="btn btn-primary">{label}</button>;
};
`,
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root, ignoreSnoozeFile: true });
      const dupFn = result.findings.filter((f) => f.detectorId === 'duplicate-function');
      expect(dupFn.length).toBeGreaterThanOrEqual(1);
      // Should reference both component names.
      const allText = dupFn.map((f) => f.title + ' ' + f.description).join(' ');
      expect(allText).toContain('PrimaryButton');
      expect(allText).toContain('HeroButton');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects a duplicate component when one is `function Foo()` and the other `const Bar = () => ...`', async () => {
    const root = await setup({
      'src/components/Named.tsx': `
import React from 'react';
export function Named({ count }: { count: number }): JSX.Element {
  return <span className="badge">{count}</span>;
}
`,
      'src/components/Arrow.tsx': `
import React from 'react';
export const Arrow = ({ count }: { count: number }): JSX.Element => {
  return <span className="badge">{count}</span>;
};
`,
    });
    try {
      const rothunter = new RotHunter();
      const result = await rothunter.run({ workspaceRoot: root, ignoreSnoozeFile: true });
      const dupFn = result.findings.filter((f) => f.detectorId === 'duplicate-function');
      // The bodies are structurally identical even though one is a function
      // declaration and the other an arrow assigned to a const. Either layer
      // (strict on the body / structural after identifier anonymisation)
      // should fire.
      expect(dupFn.length).toBeGreaterThanOrEqual(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
