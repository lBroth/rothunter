import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileCode,
  Folder,
  FolderOpen,
} from 'lucide-react';
import type {
  SymbolDetail,
  SymbolFileEntry,
  SymbolFileResponse,
  SymbolTreeNode,
} from '../lib/api.js';
import { getSymbolDetail, getSymbolFile, getSymbolTree } from '../lib/api.js';
import { SectionHeader } from '../components/SectionHeader.js';

export function Symbols(): JSX.Element {
  const [tree, setTree] = useState<SymbolTreeNode | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileResp, setFileResp] = useState<SymbolFileResponse | null>(null);
  const [detail, setDetail] = useState<SymbolDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getSymbolTree()
      .then((t) => {
        setTree(t);
        // Auto-focus the first file with HIGH findings, or first file overall.
        const first = pickInitial(t);
        if (first) setActiveFile(first);
      })
      .catch((e: Error) => setErr(e.message));
  }, []);

  useEffect(() => {
    if (!activeFile) {
      setFileResp(null);
      setDetail(null);
      return;
    }
    getSymbolFile(activeFile)
      .then((f) => {
        setFileResp(f);
        // Default-focus the first symbol so the right rail isn't blank.
        if (f.symbols.length > 0) {
          void getSymbolDetail(f.symbols[0]!.name, activeFile).then(setDetail);
        } else {
          setDetail(null);
        }
      })
      .catch((e: Error) => setErr(e.message));
  }, [activeFile]);

  if (err) return <div className="text-high">error: {err}</div>;

  const stats = computeRootStats(tree);

  return (
    <div className="space-y-6 max-w-screen-2xl">
      <SectionHeader
        eyebrow="SYMBOL GRAPH · RESOLVED AT SCAN"
        title={
          <span>
            <span className="text-ink tabular-nums">{stats.symbols.toLocaleString('en-US')} symbols</span>{' '}
            <span className="text-muted">· {stats.files.toLocaleString('en-US')} files</span>
          </span>
        }
      />

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        {/* Tree */}
        <aside className="xl:col-span-3 rounded-lg border border-border bg-panel overflow-hidden">
          <header className="px-4 py-2.5 border-b border-border-soft flex items-baseline gap-2">
            <span className="text-sm font-semibold text-ink">Tree</span>
            <span className="text-xs text-muted font-mono">by directory</span>
          </header>
          <div className="max-h-[70vh] overflow-y-auto py-2">
            {tree ? (
              <TreeBranch
                node={tree}
                depth={0}
                activeFile={activeFile}
                onSelect={setActiveFile}
                query=""
              />
            ) : (
              <div className="px-4 py-6 text-xs text-muted">parsing workspace…</div>
            )}
          </div>
        </aside>

        {/* Symbol table for selected file */}
        <section className="xl:col-span-5 rounded-lg border border-border bg-panel overflow-hidden">
          <header className="px-4 py-2.5 border-b border-border-soft flex items-baseline gap-2 truncate">
            <span className="text-sm font-semibold text-ink truncate">
              {fileResp?.file ?? 'select a file from the tree'}
            </span>
            {fileResp && (
              <span className="text-xs text-muted font-mono whitespace-nowrap">
                {fileResp.symbolCount} symbols
                {fileResp.h > 0 && (
                  <span className="text-high"> · {fileResp.h} HIGH</span>
                )}
              </span>
            )}
          </header>
          {fileResp ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-muted font-mono border-b border-border-soft">
                  <th className="text-left font-normal px-4 py-2.5">symbol</th>
                  <th className="text-left font-normal py-2.5 w-28">kind</th>
                  <th className="text-right font-normal py-2.5 w-16">line</th>
                  <th className="text-right font-normal py-2.5 w-12">in</th>
                  <th className="text-right font-normal py-2.5 w-12 pr-4">out</th>
                </tr>
              </thead>
              <tbody>
                {fileResp.symbols.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-muted text-sm">
                      No top-level symbols in this file.
                    </td>
                  </tr>
                ) : (
                  fileResp.symbols.map((s) => (
                    <SymbolRow
                      key={s.id}
                      symbol={s}
                      activeName={detail?.name ?? null}
                      onPick={() => {
                        void getSymbolDetail(s.name, fileResp.file).then(setDetail);
                      }}
                    />
                  ))
                )}
              </tbody>
            </table>
          ) : (
            <div className="px-4 py-12 text-center text-muted text-sm">
              Choose a file in the tree to inspect its symbols.
            </div>
          )}
        </section>

        {/* Symbol detail rail */}
        <aside className="xl:col-span-4 space-y-4">
          {detail ? (
            <SymbolDetailCard detail={detail} onPickFile={setActiveFile} />
          ) : (
            <div className="rounded-lg border border-border bg-panel px-4 py-12 text-center text-sm text-muted">
              Pick a symbol to inspect callers + callees.
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

interface TreeBranchProps {
  node: SymbolTreeNode;
  depth: number;
  activeFile: string | null;
  onSelect: (path: string) => void;
  query: string;
}

function TreeBranch({ node, depth, activeFile, onSelect, query }: TreeBranchProps): JSX.Element {
  const [open, setOpen] = useState<boolean>(depth < 2 || node.h > 0);

  if (depth === 0) {
    return (
      <ul>
        {node.children.map((c) => (
          <TreeBranch
            key={c.path}
            node={c}
            depth={depth + 1}
            activeFile={activeFile}
            onSelect={onSelect}
            query={query}
          />
        ))}
      </ul>
    );
  }

  if (query && !matchesQuery(node, query)) return <></>;

  const indent = { paddingLeft: `${depth * 12 + 12}px` };

  if (node.kind === 'file') {
    const active = activeFile === node.path;
    return (
      <li>
        <button
          type="button"
          onClick={() => onSelect(node.path)}
          style={indent}
          className={
            'w-full text-left flex items-center gap-2 py-1 text-xs font-mono pr-3 ' +
            (active ? 'bg-accent/10 text-ink' : 'text-muted hover:bg-bg hover:text-ink')
          }
        >
          <FileCode size={12} className={active ? 'text-accent' : 'text-muted'} />
          <span className="flex-1 truncate">{node.name}</span>
          <CountChips h={node.h} m={node.m} l={node.l} small />
          <span className="text-[10px] text-muted tabular-nums w-8 text-right">{node.symbolCount}</span>
        </button>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={indent}
        className="w-full text-left flex items-center gap-2 py-1 text-xs font-mono text-ink hover:bg-bg pr-3"
      >
        {open ? <ChevronDown size={11} className="text-muted" /> : <ChevronRight size={11} className="text-muted" />}
        {open ? <FolderOpen size={12} className="text-muted" /> : <Folder size={12} className="text-muted" />}
        <span className="flex-1 truncate">{node.name}</span>
        <CountChips h={node.h} m={node.m} l={node.l} small />
        <span className="text-[10px] text-muted tabular-nums w-10 text-right">{node.symbolCount}</span>
      </button>
      {open && (
        <ul>
          {node.children.map((c) => (
            <TreeBranch
              key={c.path}
              node={c}
              depth={depth + 1}
              activeFile={activeFile}
              onSelect={onSelect}
              query={query}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function CountChips({ h, m, l, small }: { h: number; m: number; l: number; small?: boolean }): JSX.Element {
  const cls = small ? 'text-[10px]' : 'text-[11px]';
  return (
    <span className={'flex items-center gap-1 font-mono tabular-nums ' + cls}>
      {h > 0 && <span className="text-high">{h}</span>}
      {m > 0 && <span className="text-med">{m}</span>}
      {l > 0 && <span className="text-low">{l}</span>}
    </span>
  );
}

function SymbolRow({
  symbol,
  activeName,
  onPick,
}: {
  symbol: SymbolFileEntry;
  activeName: string | null;
  onPick: () => void;
}): JSX.Element {
  const active = activeName === symbol.name;
  return (
    <tr
      className={
        'cursor-pointer border-b border-border-soft last:border-b-0 ' +
        (active ? 'bg-accent/10' : 'hover:bg-bg')
      }
      onClick={onPick}
    >
      <td className="px-4 py-2 font-mono text-xs">
        <span className="flex items-center gap-2 min-w-0">
          <span className={'w-1.5 h-1.5 rounded-full ' + (active ? 'bg-accent' : 'bg-border')} />
          <span className={'truncate ' + (symbol.exported ? 'text-ink' : 'text-muted')}>
            {symbol.name}
          </span>
        </span>
      </td>
      <td className="py-2 font-mono text-[11px] text-muted">{symbol.kind}</td>
      <td className="py-2 text-right font-mono text-[11px] text-muted tabular-nums">
        {symbol.line}
      </td>
      <td className="py-2 text-right font-mono text-[11px] text-muted tabular-nums">
        {symbol.in}
      </td>
      <td className="py-2 pr-4 text-right font-mono text-[11px] text-muted tabular-nums">
        {symbol.out}
      </td>
    </tr>
  );
}

function SymbolDetailCard({
  detail,
  onPickFile,
}: {
  detail: SymbolDetail;
  onPickFile: (file: string) => void;
}): JSX.Element {
  return (
    <>
      <section className="rounded-lg border border-border bg-panel overflow-hidden">
        <header className="px-4 py-3 border-b border-border-soft flex items-baseline gap-2">
          <span className="font-mono text-sm text-ink truncate">{detail.name}</span>
          <span className="text-xs text-muted font-mono">{detail.kind}</span>
          {detail.exported && (
            <span className="ml-auto text-[10px] text-accent font-mono tracking-widest">
              EXPORTED
            </span>
          )}
        </header>
        <div className="px-4 py-3 text-xs text-muted font-mono space-y-1.5">
          <div>
            declared at{' '}
            <button
              type="button"
              onClick={() => onPickFile(detail.file)}
              className="text-ink hover:text-accent"
            >
              {detail.file}:{detail.line}
            </button>
          </div>
        </div>
        <pre className="px-4 pb-4 text-[11px] font-mono text-ink whitespace-pre-wrap break-all">
          {detail.signature}
        </pre>
      </section>

      <section className="rounded-lg border border-border bg-panel overflow-hidden">
        <header className="px-4 py-2.5 border-b border-border-soft flex items-baseline gap-2">
          <span className="text-sm font-semibold text-ink">Callers</span>
          <span className="text-xs text-muted font-mono">{detail.callers.length}</span>
        </header>
        <ul className="divide-y divide-border-soft max-h-[28vh] overflow-y-auto">
          {detail.callers.length === 0 ? (
            <li className="px-4 py-3 text-xs text-muted">No file imports this symbol.</li>
          ) : (
            detail.callers.map((c) => (
              <li key={c}>
                <button
                  type="button"
                  onClick={() => onPickFile(c)}
                  className="w-full text-left px-4 py-2 text-xs font-mono text-muted hover:text-ink hover:bg-bg truncate"
                >
                  {c}
                </button>
              </li>
            ))
          )}
        </ul>
      </section>

      <section className="rounded-lg border border-border bg-panel overflow-hidden">
        <header className="px-4 py-2.5 border-b border-border-soft flex items-baseline gap-2">
          <span className="text-sm font-semibold text-ink">Callees</span>
          <span className="text-xs text-muted font-mono">{detail.callees.length}</span>
        </header>
        <ul className="divide-y divide-border-soft max-h-[28vh] overflow-y-auto">
          {detail.callees.length === 0 ? (
            <li className="px-4 py-3 text-xs text-muted">This file imports nothing from within the workspace.</li>
          ) : (
            detail.callees.map((c) => (
              <li key={c}>
                <button
                  type="button"
                  onClick={() => onPickFile(c)}
                  className="w-full text-left px-4 py-2 text-xs font-mono text-muted hover:text-ink hover:bg-bg truncate"
                >
                  {c}
                </button>
              </li>
            ))
          )}
        </ul>
      </section>
    </>
  );
}

function pickInitial(tree: SymbolTreeNode): string | null {
  function walk(n: SymbolTreeNode): string | null {
    if (n.kind === 'file') return n.path;
    for (const c of n.children) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  }
  // Prefer the first file with a HIGH finding; fall back to the first file.
  function withHigh(n: SymbolTreeNode): string | null {
    if (n.kind === 'file' && n.h > 0) return n.path;
    for (const c of n.children) {
      const r = withHigh(c);
      if (r) return r;
    }
    return null;
  }
  return withHigh(tree) ?? walk(tree);
}

function matchesQuery(node: SymbolTreeNode, q: string): boolean {
  if (node.path.toLowerCase().includes(q)) return true;
  if (node.kind === 'dir') {
    return node.children.some((c) => matchesQuery(c, q));
  }
  return false;
}

function computeRootStats(tree: SymbolTreeNode | null): { symbols: number; files: number } {
  if (!tree) return { symbols: 0, files: 0 };
  let files = 0;
  function walk(n: SymbolTreeNode): void {
    if (n.kind === 'file') files += 1;
    n.children.forEach(walk);
  }
  walk(tree);
  return { symbols: tree.symbolCount, files };
}
