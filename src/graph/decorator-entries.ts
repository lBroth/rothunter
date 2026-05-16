import * as path from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';

// Files with framework decorators (NestJS, Angular, TypeGraphQL, Inversify,
// TypeORM, tsoa) are entry points — DI / ORM discovers them at runtime.
// Textual match; over-match is safe direction (protects from dead-module).
const FRAMEWORK_DECORATOR_NAMES = new Set([
  // NestJS class-level
  'Controller',
  'Module',
  'Injectable',
  'Catch',
  'Pipe',
  'WebSocketGateway',
  'Resolver',
  // NestJS method-level
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'All',
  'Options',
  'Head',
  'Sse',
  'MessagePattern',
  'EventPattern',
  'SubscribeMessage',
  // GraphQL (TypeGraphQL / Nest-graphql)
  'Query',
  'Mutation',
  'FieldResolver',
  'Subscription',
  'ObjectType',
  'InputType',
  // Angular
  'Component',
  'NgModule',
  'Directive',
  // ORM auto-discovery
  'Entity',
  'ViewEntity',
  'Schema',
  // InversifyJS DI
  'injectable',
  'inject',
  // tsoa / route-decorator HTTP frameworks
  'Route',
  'Tags',
]);

export function resolveDecoratorEntryFiles(
  workspaceRoot: string,
  files: ReadonlyArray<string>,
): Set<string> {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });
  for (const rel of files) {
    project.addSourceFileAtPathIfExists(path.join(workspaceRoot, rel));
  }

  const out = new Set<string>();
  for (const sf of project.getSourceFiles()) {
    if (fileHasFrameworkDecorator(sf)) {
      out.add(path.relative(workspaceRoot, sf.getFilePath()));
    }
  }
  return out;
}

function fileHasFrameworkDecorator(sf: ReturnType<Project['getSourceFiles']>[number]): boolean {
  // Class-level + method-level decorators. We use the Decorator AST kind so
  // we catch both `@Decorator()` and `@Decorator` invocation shapes.
  for (const dec of sf.getDescendantsOfKind(SyntaxKind.Decorator)) {
    const expr = dec.getExpression();
    let name: string | null = null;
    const callShape = expr.asKind(SyntaxKind.CallExpression);
    if (callShape) {
      name = callShape.getExpression().getText();
    } else if (expr.getKind() === SyntaxKind.Identifier) {
      name = expr.getText();
    }
    if (!name) continue;
    // Decorators are often imported with their bare name (e.g. `@Controller`),
    // sometimes namespaced (`@nestjs.Controller`). Pick the last segment.
    const baseName = name.split('.').pop() ?? name;
    if (FRAMEWORK_DECORATOR_NAMES.has(baseName)) return true;
  }
  return false;
}
