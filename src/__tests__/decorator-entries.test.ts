import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TypeScriptParser } from '../parsers/typescript-parser.js';
import { resolveDecoratorEntryFiles } from '../graph/decorator-entries.js';

async function setup(files: Record<string, string>): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rothunter-decorator-'));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf-8');
  }
  return root;
}

describe('decorator-entries resolution', () => {
  it('treats a NestJS @Controller class file as an entry point', async () => {
    const root = await setup({
      'src/users/users.controller.ts': `
declare function Controller(prefix: string): ClassDecorator;
declare function Get(path: string): MethodDecorator;
@Controller('users')
export class UsersController {
  @Get(':id')
  findOne(): string { return 'x'; }
}
`,
      'src/util/helper.ts': 'export function help(): void {}\n',
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const entries = resolveDecoratorEntryFiles(root, parsed.files);
      expect(entries.has('src/users/users.controller.ts')).toBe(true);
      expect(entries.has('src/util/helper.ts')).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('protects TypeORM @Entity classes from dead-module', async () => {
    const root = await setup({
      'src/entities/user.ts': `
declare function Entity(): ClassDecorator;
declare function Column(): PropertyDecorator;
@Entity()
export class User {
  @Column() name!: string;
}
`,
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const entries = resolveDecoratorEntryFiles(root, parsed.files);
      expect(entries.has('src/entities/user.ts')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('protects TypeGraphQL @Resolver / @Query files', async () => {
    const root = await setup({
      'src/graphql/user.resolver.ts': `
declare function Resolver(of?: unknown): ClassDecorator;
declare function Query(returnType: () => unknown): MethodDecorator;
@Resolver()
export class UserResolver {
  @Query(() => String)
  hello(): string { return 'hi'; }
}
`,
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const entries = resolveDecoratorEntryFiles(root, parsed.files);
      expect(entries.has('src/graphql/user.resolver.ts')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('protects Angular @Component / @NgModule files', async () => {
    const root = await setup({
      'src/app/app.component.ts': `
declare function Component(meta: unknown): ClassDecorator;
@Component({ selector: 'app-root', template: '' })
export class AppComponent {}
`,
      'src/app/app.module.ts': `
declare function NgModule(meta: unknown): ClassDecorator;
@NgModule({ declarations: [], imports: [], bootstrap: [] })
export class AppModule {}
`,
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const entries = resolveDecoratorEntryFiles(root, parsed.files);
      expect(entries.has('src/app/app.component.ts')).toBe(true);
      expect(entries.has('src/app/app.module.ts')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty for files with no framework decorators', async () => {
    const root = await setup({
      'src/plain.ts': 'export function fn(): void {}\n',
    });
    try {
      const parser = new TypeScriptParser();
      const parsed = await parser.parseWorkspaceFull({ workspaceRoot: root });
      const entries = resolveDecoratorEntryFiles(root, parsed.files);
      expect(entries.size).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
