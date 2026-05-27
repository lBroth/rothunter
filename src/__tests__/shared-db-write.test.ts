import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectSharedDbWrites } from '../detectors/shared-db-write.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-shared-db-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('shared-db-write detector (Prisma)', () => {
  it('flags `User.email` written by two distinct files (API + worker race candidate)', async () => {
    const root = await setup({
      'src/api/profile.ts': `
declare const prisma: any;
export async function patchProfile(userId: string, email: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { email, updatedAt: new Date() } });
}
`,
      'src/workers/sync.ts': `
declare const prisma: any;
export async function syncEmail(userId: string, externalEmail: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { email: externalEmail } });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/api/profile.ts', 'src/workers/sync.ts'],
      });
      const titles = findings.map((f) => f.title);
      expect(titles).toEqual(expect.arrayContaining([expect.stringContaining('user.email')]));
      // updatedAt only appears in one file → not flagged.
      expect(titles).not.toEqual(
        expect.arrayContaining([expect.stringContaining('user.updatedAt')]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a column written by only one file', async () => {
    const root = await setup({
      'src/api/profile.ts': `
declare const prisma: any;
export async function patchOnce(id: string): Promise<void> {
  await prisma.user.update({ where: { id }, data: { displayName: 'x' } });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/api/profile.ts'],
      });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('recognises Prisma `upsert` — fields under both `update` and `create` count as writes', async () => {
    const root = await setup({
      'src/api/a.ts': `
declare const prisma: any;
export async function upA(id: string, n: number): Promise<void> {
  await prisma.counter.upsert({
    where: { id },
    update: { value: n },
    create: { id, value: n },
  });
}
`,
      'src/jobs/b.ts': `
declare const prisma: any;
export async function bumpB(id: string): Promise<void> {
  await prisma.counter.update({ where: { id }, data: { value: 1 } });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/api/a.ts', 'src/jobs/b.ts'],
      });
      expect(findings.map((f) => f.title)).toEqual(
        expect.arrayContaining([expect.stringContaining('counter.value')]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('expands `createMany({ data: [{...}, {...}] })` into all per-row columns', async () => {
    const root = await setup({
      'src/seed/seed.ts': `
declare const prisma: any;
export async function seed(): Promise<void> {
  await prisma.user.createMany({
    data: [{ email: 'a@b' }, { email: 'c@d' }],
  });
}
`,
      'src/api/profile.ts': `
declare const prisma: any;
export async function setEmail(id: string, email: string): Promise<void> {
  await prisma.user.update({ where: { id }, data: { email } });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/seed/seed.ts', 'src/api/profile.ts'],
      });
      expect(findings.map((f) => f.title)).toEqual(
        expect.arrayContaining([expect.stringContaining('user.email')]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags Sequelize `Model.update({...}, { where })` cross-file', async () => {
    const root = await setup({
      'src/api/profile.ts': `
declare const User: any;
export async function patch(id: string, email: string): Promise<void> {
  await User.update({ email }, { where: { id } });
}
`,
      'src/workers/sync.ts': `
declare const User: any;
export async function sync(id: string, email: string): Promise<void> {
  await User.update({ email }, { where: { id } });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/api/profile.ts', 'src/workers/sync.ts'],
      });
      const titles = findings.map((f) => f.title);
      expect(titles).toEqual(expect.arrayContaining([expect.stringContaining('user.email')]));
      expect(titles.some((t) => t.includes('sequelize'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags Sequelize `Model.upsert({...}, { transaction })` against another writer (Prisma)', async () => {
    const root = await setup({
      'src/jobs/counter.ts': `
declare const Counter: any;
declare const tx: any;
export async function bumpA(id: string, n: number): Promise<void> {
  await Counter.upsert({ id, value: n }, { transaction: tx });
}
`,
      'src/api/bump.ts': `
declare const prisma: any;
export async function bumpB(id: string, n: number): Promise<void> {
  await prisma.counter.update({ where: { id }, data: { value: n } });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/jobs/counter.ts', 'src/api/bump.ts'],
      });
      const titles = findings.map((f) => f.title);
      expect(titles).toEqual(expect.arrayContaining([expect.stringContaining('counter.value')]));
      // Cluster includes both adapters.
      const fst = findings.find((f) => f.title.includes('counter.value'));
      expect(fst?.title).toContain('sequelize');
      expect(fst?.title).toContain('prisma');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag non-ORM factory `*.create({...})` calls (e.g. CognitoJwtVerifier.create)', async () => {
    const root = await setup({
      'src/auth/a.ts': `
declare const CognitoJwtVerifier: any;
export function makeA(): unknown {
  return CognitoJwtVerifier.create({ userPoolId: 'p1', tokenUse: 'id', clientId: 'c1' });
}
`,
      'src/auth/b.ts': `
declare const CognitoJwtVerifier: any;
export function makeB(): unknown {
  return CognitoJwtVerifier.create({ userPoolId: 'p2', tokenUse: 'access', clientId: 'c2' });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/auth/a.ts', 'src/auth/b.ts'],
      });
      // Non-ORM factory pattern — must not be flagged as a Sequelize write.
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('Sequelize `bulkCreate([{...}, {...}])` unions per-row columns', async () => {
    const root = await setup({
      'src/seed/seed.ts': `
declare const User: any;
export async function seed(): Promise<void> {
  await User.bulkCreate([{ email: 'a@b' }, { email: 'c@d' }]);
}
`,
      'src/api/profile.ts': `
declare const User: any;
export async function setEmail(id: string, email: string): Promise<void> {
  await User.update({ email }, { where: { id } });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/seed/seed.ts', 'src/api/profile.ts'],
      });
      expect(findings.map((f) => f.title)).toEqual(
        expect.arrayContaining([expect.stringContaining('user.email')]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag a non-PascalCase Sequelize-shaped call (avoids `service.update(...)` FP)', async () => {
    const root = await setup({
      'src/a.ts': `
declare const service: any;
export async function a(id: string): Promise<void> {
  await service.update({ email: 'a' }, { where: { id } });
}
`,
      'src/b.ts': `
declare const service: any;
export async function b(id: string): Promise<void> {
  await service.update({ email: 'b' }, { where: { id } });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/a.ts', 'src/b.ts'],
      });
      // `service` is not PascalCase → not treated as a Sequelize model.
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags TypeORM `repo.update(id, {...})` cross-file', async () => {
    const root = await setup({
      'src/api/profile.ts': `
declare const userRepo: any;
export async function patchProfile(id: string, email: string): Promise<void> {
  await userRepo.update(id, { email });
}
`,
      'src/workers/sync.ts': `
declare const userRepository: any;
export async function syncEmail(id: string, email: string): Promise<void> {
  await userRepository.update({ id }, { email });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/api/profile.ts', 'src/workers/sync.ts'],
      });
      const titles = findings.map((f) => f.title);
      expect(titles).toEqual(expect.arrayContaining([expect.stringContaining('user.email')]));
      expect(titles.some((t) => t.includes('typeorm'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags TypeORM `getRepository(E).update(...)` chain', async () => {
    const root = await setup({
      'src/api/a.ts': `
declare const getRepository: any;
declare class Order {}
export async function setStatus(id: string, status: string): Promise<void> {
  await getRepository(Order).update(id, { status });
}
`,
      'src/api/b.ts': `
declare const orderRepo: any;
export async function ackStatus(id: string): Promise<void> {
  await orderRepo.update(id, { status: 'acked' });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/api/a.ts', 'src/api/b.ts'],
      });
      expect(findings.map((f) => f.title)).toEqual(
        expect.arrayContaining([expect.stringContaining('order.status')]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags Mongoose `Model.updateOne(filter, { $set: {...} })`', async () => {
    const root = await setup({
      'src/api/a.ts': `
declare const User: any;
export async function setName(id: string, name: string): Promise<void> {
  await User.updateOne({ _id: id }, { $set: { displayName: name } });
}
`,
      'src/api/b.ts': `
declare const User: any;
export async function rename(id: string, dn: string): Promise<void> {
  await User.findOneAndUpdate({ _id: id }, { $set: { displayName: dn } });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/api/a.ts', 'src/api/b.ts'],
      });
      const titles = findings.map((f) => f.title);
      expect(titles).toEqual(expect.arrayContaining([expect.stringContaining('user.displayName')]));
      expect(titles.some((t) => t.includes('mongoose'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags Mongoose `this.catModel.findByIdAndUpdate(id, dto)` (NestJS shape)', async () => {
    const root = await setup({
      'src/cats/cats.service.ts': `
declare const Cat: any;
type Model<T> = any;
export class CatsService {
  constructor(private readonly catModel: Model<typeof Cat>) {}
  async rename(id: string, name: string): Promise<void> {
    await this.catModel.findByIdAndUpdate({ _id: id }, { displayName: name }, { new: true });
  }
}
`,
      'src/cats/bulk.ts': `
declare const Cat: any;
type Model<T> = any;
export class BulkRenameService {
  constructor(private readonly catModel: Model<typeof Cat>) {}
  async renameAll(name: string): Promise<void> {
    await this.catModel.updateMany({}, { displayName: name });
  }
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/cats/cats.service.ts', 'src/cats/bulk.ts'],
      });
      const titles = findings.map((f) => f.title);
      expect(titles).toEqual(expect.arrayContaining([expect.stringContaining('cat.displayName')]));
      expect(titles.some((t) => t.includes('mongoose'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags Mongoose `Model.create(dto)` cross-file', async () => {
    const root = await setup({
      'src/api/a.ts': `
declare const Profile: any;
export async function signupApi(name: string, email: string): Promise<void> {
  await Profile.create({ displayName: name, email });
}
`,
      'src/jobs/b.ts': `
declare const Profile: any;
export async function importProfile(name: string, email: string): Promise<void> {
  await Profile.create({ displayName: name, email });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/api/a.ts', 'src/jobs/b.ts'],
      });
      const titles = findings.map((f) => f.title);
      expect(titles).toEqual(
        expect.arrayContaining([expect.stringContaining('profile.displayName')]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags Mongoose `Model.insertMany([{...}, ...])` cross-file', async () => {
    const root = await setup({
      'src/seed/a.ts': `
declare const User: any;
export async function seed(): Promise<void> {
  await User.insertMany([{ email: 'a@b' }, { email: 'c@d' }]);
}
`,
      'src/api/b.ts': `
declare const User: any;
export async function patch(id: string, email: string): Promise<void> {
  await User.updateOne({ _id: id }, { $set: { email } });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/seed/a.ts', 'src/api/b.ts'],
      });
      expect(findings.map((f) => f.title)).toEqual(
        expect.arrayContaining([expect.stringContaining('user.email')]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('Mongoose: strips `$inc` and other operator keys from the bare-update shape', async () => {
    const root = await setup({
      'src/api/a.ts': `
declare const Counter: any;
export async function bump(id: string): Promise<void> {
  await Counter.updateOne({ _id: id }, { $inc: { value: 1 } });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/api/a.ts'],
      });
      // `$inc` is the only key — gets stripped — nothing to flag.
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags Knex `knex('users').update({...})` and `knex('users').where(...).update(...)`", async () => {
    const root = await setup({
      'src/api/a.ts': `
declare const knex: any;
export async function patch(id: string, email: string): Promise<void> {
  await knex('users').where({ id }).update({ email });
}
`,
      'src/workers/b.ts': `
declare const db: any;
export async function sync(id: string, email: string): Promise<void> {
  await db.from('users').update({ email });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/api/a.ts', 'src/workers/b.ts'],
      });
      const titles = findings.map((f) => f.title);
      expect(titles).toEqual(expect.arrayContaining([expect.stringContaining('users.email')]));
      expect(titles.some((t) => t.includes('knex'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags Drizzle `db.update(usersTable).set({...})` cross-file', async () => {
    const root = await setup({
      'src/api/a.ts': `
declare const db: any;
declare const usersTable: any;
declare const eq: any;
export async function patch(id: string, email: string): Promise<void> {
  await db.update(usersTable).set({ email }).where(eq(usersTable.id, id));
}
`,
      'src/jobs/b.ts': `
declare const db: any;
declare const usersTable: any;
export async function sync(email: string): Promise<void> {
  await db.insert(usersTable).values({ email });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/api/a.ts', 'src/jobs/b.ts'],
      });
      const titles = findings.map((f) => f.title);
      // Entities are lowercased before clustering — `usersTable` → `userstable`.
      expect(titles).toEqual(expect.arrayContaining([expect.stringContaining('userstable.email')]));
      expect(titles.some((t) => t.includes('drizzle'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags raw SQL `pg.query("UPDATE users SET email = $1", [...])`', async () => {
    const root = await setup({
      'src/api/a.ts': `
declare const pg: any;
export async function patch(email: string): Promise<void> {
  await pg.query('UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2', [email, 1]);
}
`,
      'src/jobs/b.ts': `
declare const prisma: any;
export async function sync(id: string, email: string): Promise<void> {
  await prisma.$executeRawUnsafe('UPDATE users SET email = ? WHERE id = ?', email, id);
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/api/a.ts', 'src/jobs/b.ts'],
      });
      const titles = findings.map((f) => f.title);
      expect(titles).toEqual(expect.arrayContaining([expect.stringContaining('users.email')]));
      expect(titles.some((t) => t.includes('raw-sql'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags raw SQL `INSERT INTO users (email, name) VALUES (...)` across files', async () => {
    const root = await setup({
      'src/seed/a.ts': `
declare const client: any;
export async function seed(): Promise<void> {
  await client.query('INSERT INTO users (email, name) VALUES ($1, $2)', ['a@b', 'A']);
}
`,
      'src/api/b.ts': `
declare const knex: any;
export async function reg(email: string): Promise<void> {
  await knex.raw('UPDATE users SET email = ? WHERE id = ?', [email, 1]);
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/seed/a.ts', 'src/api/b.ts'],
      });
      expect(findings.map((f) => f.title)).toEqual(
        expect.arrayContaining([expect.stringContaining('users.email')]),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT flag two writes to the same column in the SAME file', async () => {
    const root = await setup({
      'src/api/profile.ts': `
declare const prisma: any;
export async function a(id: string): Promise<void> {
  await prisma.user.update({ where: { id }, data: { email: 'a' } });
}
export async function b(id: string): Promise<void> {
  await prisma.user.update({ where: { id }, data: { email: 'b' } });
}
`,
    });
    try {
      const findings = detectSharedDbWrites({
        workspaceRoot: root,
        files: ['src/api/profile.ts'],
      });
      expect(findings).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
