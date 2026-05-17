import * as path from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';

/**
 * Decorator-driven entry-point detection.
 *
 * Framework-discovered classes (NestJS controllers, Angular components,
 * tRPC routers, TypeGraphQL resolvers, etc.) are not statically imported
 * by anything — the framework's dependency-injection container finds them
 * at runtime by scanning for decorated classes. Without this walker, the
 * dead-module / dead-export detectors false-positive on every Nest
 * controller.
 *
 * Files containing ANY of the recognised framework decorators (at the
 * class level OR on instance methods) are returned as entry points.
 *
 * Recognised decorators (case-sensitive, framework conventions):
 *
 *   NestJS:           @Controller @Module @Injectable @Catch @Pipe
 *                     @WebSocketGateway @SubscribeMessage
 *                     @Get @Post @Put @Patch @Delete @All @Options @Head
 *                     @Sse @MessagePattern @EventPattern
 *   tRPC v10/v11:     (no decorators — handled by entry-points.ts conventions)
 *   TypeGraphQL:      @Resolver @Query @Mutation @FieldResolver @Subscription
 *   class-validator:  (used inside DTOs — not entry-point signal)
 *   Angular:          @Component @NgModule @Injectable @Directive @Pipe
 *                     @Injectable @Input @Output @HostListener
 *   InversifyJS:      @injectable @inject
 *   TypeORM entities: @Entity @ViewEntity @Schema (Mongoose) — these are
 *                     definition decorators; treat the file as an entry
 *                     because ORM auto-discovers them at startup.
 *   Type-graphql/tsoa style HTTP: @Route, @Get, @Post (tsoa)
 *
 * Implementation is intentionally a textual decorator-name check over the
 * AST — we don't try to resolve which `@Controller` (Nest vs custom). Cost
 * of an over-match is "we protect a few extra files from dead-module",
 * which is the safe direction.
 */
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
    if (expr.getKind() === SyntaxKind.CallExpression) {
      const callExpr = (expr as { getExpression(): { getText(): string } }).getExpression();
      name = callExpr.getText();
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
