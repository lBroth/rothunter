import { Node, SyntaxKind } from 'ts-morph';

/**
 * Basic-block control-flow graph for an async function body. The race-
 * condition detector previously used source-line ordering as a proxy for
 * execution order — that misfires on conditional reads (`if (cond) { read }
 * await x; write`) because the analyzer cannot tell whether `read` actually
 * happened on a given execution. With a CFG we ask the precise question:
 * "Does any execution path reach `read`, then `await`, then `write` of the
 * same target?". If no such path exists → no race candidate.
 *
 * The graph is intentionally coarse: each node is a sequence of statements
 * with no internal branch. Branch / loop / try-catch / switch produce
 * separate nodes joined by `succ` edges. Statements that terminate a path
 * (`return`, `throw`, `break`, `continue`) end the block with no successor
 * to the synthetic exit. Reachability is plain forward BFS.
 *
 * Caveats:
 *   - Switch fall-through across cases is modelled correctly only when the
 *     case body ends with `break` / `return`. Implicit fall-through joins
 *     the next case's entry.
 *   - Labeled break/continue is reduced to plain break/continue (good
 *     enough for race-condition use; very rare in practice).
 *   - Nested function declarations / arrow functions are NOT followed —
 *     they have their own CFG built by the caller when needed.
 */
export interface CfgBlock {
  id: number;
  stmts: Node[];
  succ: number[];
}

export interface Cfg {
  blocks: CfgBlock[];
  entry: number;
  exit: number;
}

interface LoopCtx {
  breakTarget?: CfgBlock;
  continueTarget?: CfgBlock;
}

const TERMINATING_KINDS = new Set<SyntaxKind>([
  SyntaxKind.ReturnStatement,
  SyntaxKind.ThrowStatement,
  SyntaxKind.BreakStatement,
  SyntaxKind.ContinueStatement,
]);

export function buildCfg(body: Node): Cfg {
  const blocks: CfgBlock[] = [];
  const newBlock = (): CfgBlock => {
    const b: CfgBlock = { id: blocks.length, stmts: [], succ: [] };
    blocks.push(b);
    return b;
  };
  const entry = newBlock();
  const exit = newBlock();

  const visitStmts = (stmts: ReadonlyArray<Node>, cur: CfgBlock, ctx: LoopCtx): CfgBlock => {
    let block = cur;
    for (const s of stmts) {
      block = visitStmt(s, block, ctx);
      // After a terminator we keep a sink block so subsequent statements
      // still have a CFG node — but with no successor to the exit, the
      // reachability analysis correctly skips them.
      if (TERMINATING_KINDS.has(s.getKind())) {
        block = newBlock(); // dead block; intentionally unreachable
      }
    }
    return block;
  };

  const stmtArray = (n: Node | undefined): Node[] => {
    if (!n) return [];
    const blockNode = n.asKind(SyntaxKind.Block);
    if (blockNode) return blockNode.getStatements();
    return [n];
  };

  const bodyStmts = stmtArray(body);

  const visitStmt = (s: Node, cur: CfgBlock, ctx: LoopCtx): CfgBlock => {
    cur.stmts.push(s);
    const k = s.getKind();

    if (k === SyntaxKind.IfStatement) {
      const ifn = s.asKindOrThrow(SyntaxKind.IfStatement);
      const thenB = newBlock();
      const elseB = newBlock();
      const join = newBlock();
      cur.succ.push(thenB.id, elseB.id);
      const endThen = visitStmts(stmtArray(ifn.getThenStatement()), thenB, ctx);
      endThen.succ.push(join.id);
      const elseStmt = ifn.getElseStatement();
      if (elseStmt) {
        const endElse = visitStmts(stmtArray(elseStmt), elseB, ctx);
        endElse.succ.push(join.id);
      } else {
        elseB.succ.push(join.id);
      }
      return join;
    }

    if (k === SyntaxKind.WhileStatement || k === SyntaxKind.DoStatement) {
      const loopNode = s.asKindOrThrow(
        k === SyntaxKind.WhileStatement ? SyntaxKind.WhileStatement : SyntaxKind.DoStatement,
      );
      const header = newBlock();
      const bodyB = newBlock();
      const afterB = newBlock();
      cur.succ.push(header.id);
      header.succ.push(bodyB.id, afterB.id);
      const endBody = visitStmts(stmtArray(loopNode.getStatement()), bodyB, {
        breakTarget: afterB,
        continueTarget: header,
      });
      endBody.succ.push(header.id);
      return afterB;
    }

    if (
      k === SyntaxKind.ForStatement ||
      k === SyntaxKind.ForOfStatement ||
      k === SyntaxKind.ForInStatement
    ) {
      const loopNode = s as unknown as { getStatement(): Node | undefined };
      const header = newBlock();
      const bodyB = newBlock();
      const afterB = newBlock();
      cur.succ.push(header.id);
      header.succ.push(bodyB.id, afterB.id);
      const endBody = visitStmts(stmtArray(loopNode.getStatement()), bodyB, {
        breakTarget: afterB,
        continueTarget: header,
      });
      endBody.succ.push(header.id);
      return afterB;
    }

    if (k === SyntaxKind.TryStatement) {
      const tryNode = s.asKindOrThrow(SyntaxKind.TryStatement);
      const tryB = newBlock();
      const catchB = newBlock();
      const finallyB = newBlock();
      const after = newBlock();
      cur.succ.push(tryB.id);
      // Any point in the try block can throw, so the catch is potentially
      // reachable from the try entry. We approximate with edge tryB → catchB.
      tryB.succ.push(catchB.id);
      const endTry = visitStmts(tryNode.getTryBlock().getStatements(), tryB, ctx);
      endTry.succ.push(finallyB.id);
      const catchClause = tryNode.getCatchClause();
      if (catchClause) {
        const endCatch = visitStmts(catchClause.getBlock().getStatements(), catchB, ctx);
        endCatch.succ.push(finallyB.id);
      } else {
        catchB.succ.push(finallyB.id);
      }
      const fin = tryNode.getFinallyBlock();
      if (fin) {
        const endFin = visitStmts(fin.getStatements(), finallyB, ctx);
        endFin.succ.push(after.id);
      } else {
        finallyB.succ.push(after.id);
      }
      return after;
    }

    if (k === SyntaxKind.SwitchStatement) {
      const sw = s.asKindOrThrow(SyntaxKind.SwitchStatement);
      const after = newBlock();
      const cases = sw.getCaseBlock().getClauses();
      let prev: CfgBlock | null = null;
      for (const c of cases) {
        const cb = newBlock();
        cur.succ.push(cb.id);
        if (prev) prev.succ.push(cb.id); // implicit fall-through
        const stmts = (c as { getStatements?: () => Node[] }).getStatements?.() ?? [];
        const endCase = visitStmts(stmts, cb, {
          breakTarget: after,
          continueTarget: ctx.continueTarget,
        });
        endCase.succ.push(after.id);
        prev = endCase;
      }
      cur.succ.push(after.id); // path with no matching case
      return after;
    }

    if (k === SyntaxKind.BreakStatement && ctx.breakTarget) {
      cur.succ.push(ctx.breakTarget.id);
      return cur;
    }
    if (k === SyntaxKind.ContinueStatement && ctx.continueTarget) {
      cur.succ.push(ctx.continueTarget.id);
      return cur;
    }
    if (k === SyntaxKind.ReturnStatement || k === SyntaxKind.ThrowStatement) {
      // No successor — path ends here.
      return cur;
    }

    if (k === SyntaxKind.Block) {
      // Nested block — recurse into its statements but stay in the same
      // logical block-list path (no branching).
      return visitStmts(s.asKindOrThrow(SyntaxKind.Block).getStatements(), cur, ctx);
    }

    return cur;
  };

  const last = visitStmts(bodyStmts, entry, {});
  last.succ.push(exit.id);
  return { blocks, entry: entry.id, exit: exit.id };
}

/**
 * Return the CFG block id whose statement set contains `node` (walking up
 * parents until a tracked statement is found). Returns -1 when `node`
 * lives outside the CFG (nested function body, dead block, …).
 */
export function blockOf(cfg: Cfg, node: Node): number {
  let cur: Node | undefined = node;
  while (cur) {
    for (const b of cfg.blocks) {
      if (b.stmts.includes(cur)) return b.id;
    }
    cur = cur.getParent();
  }
  return -1;
}

/** Forward reachability over the CFG: is `to` reachable from `from`? */
export function reachable(cfg: Cfg, from: number, to: number): boolean {
  if (from < 0 || to < 0) return false;
  if (from === to) return true;
  const visited = new Set<number>([from]);
  const queue: number[] = [from];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const s of cfg.blocks[id]!.succ) {
      if (s === to) return true;
      if (!visited.has(s)) {
        visited.add(s);
        queue.push(s);
      }
    }
  }
  return false;
}
