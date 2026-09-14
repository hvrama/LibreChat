#!/usr/bin/env node
/**
 * Builds the server-side Express route tree by statically walking the mounts in
 * `api/server/index.js` and every router module they reach. No database or
 * environment is needed: the routers are never required, only parsed.
 *
 *   Print:   node scripts/routes.mts
 *   Write:   node scripts/routes.mts --write     (regenerates api/server/routes/TREE.md)
 *   Check:   node scripts/routes.mts --check     (exits 1 when TREE.md is stale)
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_ROOT = join(ROOT, 'api');
const SERVER_ENTRY = join(API_ROOT, 'server/index.js');
const ROUTES_INDEX = join(API_ROOT, 'server/routes/index.js');
const OUTPUT = join(API_ROOT, 'server/routes/TREE.md');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface RouteNode {
  path: string;
  file: string;
  middleware: string[];
  endpoints: Endpoint[];
  children: RouteNode[];
}

interface Endpoint {
  method: HttpMethod;
  path: string;
}

interface RouterRef {
  file: string;
  variable: string;
}

interface UseCall {
  path: string | null;
  args: string[];
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function toRepoPath(file: string): string {
  return file.slice(ROOT.length + 1);
}

/** Reads the balanced argument list that starts right after an opening paren. */
function readCallArguments(source: string, openIndex: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === '\\') {
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '{' || char === '[') {
      depth += 1;
      continue;
    }
    if (char === ')' || char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openIndex + 1, i);
      }
    }
  }
  return source.slice(openIndex + 1);
}

/** Splits top-level comma-separated call arguments, ignoring nested commas. */
function splitArguments(argumentList: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < argumentList.length; i++) {
    const char = argumentList[i];
    if (quote) {
      current += char;
      if (char === '\\') {
        current += argumentList[i + 1] ?? '';
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if ('({['.includes(char)) {
      depth += 1;
    } else if (')}]'.includes(char)) {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function stringLiteral(argument: string): string | null {
  const match = argument.match(/^(['"`])(.*)\1$/s);
  return match ? match[2] : null;
}

function summarizeMiddleware(argument: string): string {
  if (IDENTIFIER.test(argument)) {
    return argument;
  }
  const callee = argument.match(/^([\w$.]+)\s*\(/);
  if (callee) {
    return `${callee[1]}(…)`;
  }
  return argument.startsWith('(') || argument.startsWith('async') || argument.startsWith('function')
    ? '<inline>'
    : argument.replace(/\s+/g, ' ').slice(0, 40);
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function* calls(
  source: string,
  variable: string,
  method: string,
): Generator<{ index: number; args: string[] }> {
  const pattern = new RegExp(`(?<![\\w$.])${variable}\\.${method}\\s*\\(`, 'g');
  for (const match of source.matchAll(pattern)) {
    const openIndex = match.index + match[0].length - 1;
    yield { index: match.index, args: splitArguments(readCallArguments(source, openIndex)) };
  }
}

function resolveModule(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith('~/')
    ? join(API_ROOT, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  const candidates = [`${base}.js`, join(base, 'index.js'), base];
  const isFile = (candidate: string) => existsSync(candidate) && statSync(candidate).isFile();
  return candidates.find(isFile) ?? null;
}

/** Finds which module (and export name) a local identifier was required from. */
interface RequireRef {
  specifier: string;
  exported: string;
}

function findRequire(source: string, variable: string): RequireRef | null {
  const escaped = variable.replace(/\$/g, '\\$');
  const direct = source.match(
    new RegExp(`const\\s+${escaped}\\s*=\\s*require\\(['"]([^'"]+)['"]\\)`),
  );
  if (direct) {
    return { specifier: direct[1], exported: 'default' };
  }
  const destructured = source.match(
    new RegExp(`const\\s*\\{([^}]*)\\}\\s*=\\s*require\\(['"]([^'"]+)['"]\\)`, 'g'),
  );
  for (const statement of destructured ?? []) {
    const match = statement.match(/\{([^}]*)\}\s*=\s*require\(['"]([^'"]+)['"]\)/);
    if (!match) {
      continue;
    }
    for (const entry of match[1].split(',')) {
      const [exported, local = exported] = entry.split(':').map((part) => part.trim());
      if (local === variable) {
        return { specifier: match[2], exported };
      }
    }
  }
  return null;
}

/** Maps an export name back to the router variable inside the target module. */
function exportedVariable(source: string, exported: string): string | null {
  const statement = source.match(/module\.exports\s*=\s*([\s\S]*?);/);
  if (!statement) {
    return null;
  }
  const value = statement[1].trim();
  if (exported === 'default') {
    return IDENTIFIER.test(value) ? value : null;
  }
  const body = value.match(/^\{([\s\S]*)\}$/);
  if (!body) {
    return null;
  }
  for (const entry of body[1].split(',')) {
    const [name, local = name] = entry.split(':').map((part) => part.trim());
    if (name === exported) {
      return local;
    }
  }
  return null;
}

function isRouterVariable(source: string, variable: string): boolean {
  return new RegExp(`const\\s+${variable}\\s*=\\s*(?:express\\.)?Router\\(`).test(source);
}

const sourceCache = new Map<string, string>();

async function loadSource(file: string): Promise<string> {
  const cached = sourceCache.get(file);
  if (cached) {
    return cached;
  }
  const source = stripComments(await readFile(file, 'utf8'));
  sourceCache.set(file, source);
  return source;
}

/** Resolves an identifier to the router it names, or null when it is plain middleware. */
async function resolveRouterRef(
  source: string,
  fromFile: string,
  variable: string,
): Promise<RouterRef | null> {
  if (isRouterVariable(source, variable)) {
    return { file: fromFile, variable };
  }
  const required = findRequire(source, variable);
  if (!required) {
    return null;
  }
  const file = resolveModule(fromFile, required.specifier);
  if (!file) {
    return null;
  }
  const target = await loadSource(file);
  const exported = exportedVariable(target, required.exported);
  if (!exported || !isRouterVariable(target, exported)) {
    return null;
  }
  return { file, variable: exported };
}

async function walkRouter(
  mountPath: string,
  ref: RouterRef,
  mountMiddleware: string[],
): Promise<RouteNode> {
  const source = await loadSource(ref.file);

  const node: RouteNode = {
    path: mountPath,
    file: toRepoPath(ref.file),
    middleware: [...mountMiddleware],
    endpoints: [],
    children: [],
  };

  const ordered: Array<{ index: number; apply: () => Promise<void> }> = [];

  for (const method of HTTP_METHODS) {
    for (const call of calls(source, ref.variable, method)) {
      const path = stringLiteral(call.args[0] ?? '');
      if (path === null) {
        continue;
      }
      ordered.push({
        index: call.index,
        apply: async () => {
          node.endpoints.push({ method, path });
        },
      });
    }
  }

  for (const call of calls(source, ref.variable, 'use')) {
    const use: UseCall = { path: stringLiteral(call.args[0] ?? ''), args: call.args };
    const handlers = use.path === null ? use.args : use.args.slice(1);
    const last = handlers[handlers.length - 1] ?? '';
    const childRef = IDENTIFIER.test(last) ? await resolveRouterRef(source, ref.file, last) : null;

    ordered.push({
      index: call.index,
      apply: async () => {
        if (childRef) {
          const middleware = handlers.slice(0, -1).map(summarizeMiddleware);
          node.children.push(await walkRouter(use.path ?? '/', childRef, middleware));
          return;
        }
        if (use.path === null) {
          node.middleware.push(...handlers.map(summarizeMiddleware));
        }
      },
    });
  }

  ordered.sort((a, b) => a.index - b.index);
  for (const step of ordered) {
    await step.apply();
  }
  return node;
}

interface Mount {
  path: string;
  middleware: string[];
  ref: RouterRef | null;
  label: string;
}

async function readMounts(): Promise<{ mounts: Mount[]; endpoints: Endpoint[] }> {
  const entry = await loadSource(SERVER_ENTRY);
  const routesIndex = await loadSource(ROUTES_INDEX);
  const mounts: Mount[] = [];
  const endpoints: Endpoint[] = [];

  for (const method of HTTP_METHODS) {
    for (const call of calls(entry, 'app', method)) {
      const path = stringLiteral(call.args[0] ?? '');
      if (path !== null) {
        endpoints.push({ method, path });
      }
    }
  }

  for (const call of calls(entry, 'app', 'use')) {
    const path = stringLiteral(call.args[0] ?? '');
    if (path === null) {
      continue;
    }
    const handlers = call.args.slice(1);
    const last = handlers[handlers.length - 1] ?? '';
    const middleware = handlers.slice(0, -1).map(summarizeMiddleware);
    const routeExport = last.match(/^(?:await\s+)?routes\.(\w+)(?:\.initialize\(\))?$/);

    if (!routeExport) {
      mounts.push({ path, middleware, ref: null, label: summarizeMiddleware(last) });
      continue;
    }

    const required = findRequire(routesIndex, routeExport[1]);
    const file = required ? resolveModule(ROUTES_INDEX, required.specifier) : null;
    if (!file) {
      mounts.push({ path, middleware, ref: null, label: last });
      continue;
    }
    const source = await loadSource(file);
    const variable = last.includes('initialize()')
      ? 'router'
      : exportedVariable(source, 'default');
    if (!variable || !isRouterVariable(source, variable)) {
      mounts.push({ path, middleware, ref: null, label: last });
      continue;
    }
    mounts.push({ path, middleware, ref: { file, variable }, label: last });
  }

  return { mounts, endpoints };
}

function joinPaths(base: string, path: string): string {
  const joined = `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  return joined.replace(/\/+$/, '') || '/';
}

function renderNode(node: RouteNode, base: string, prefix: string, lines: string[]): void {
  const full = joinPaths(base, node.path);
  const guards = node.middleware.length ? `  [${node.middleware.join(', ')}]` : '';
  lines.push(`${prefix}${full}${guards}  ← ${node.file}`);
  const childPrefix = `${prefix}    `;
  for (const endpoint of node.endpoints) {
    const method = endpoint.method.toUpperCase().padEnd(6);
    lines.push(`${childPrefix}${method} ${joinPaths(full, endpoint.path)}`);
  }
  for (const child of node.children) {
    renderNode(child, full, childPrefix, lines);
  }
}

async function buildTree(): Promise<string> {
  const { mounts, endpoints } = await readMounts();
  const lines: string[] = [];

  lines.push('# Express Route Tree');
  lines.push('');
  lines.push(
    'Generated by `node scripts/routes.mts --write` from `api/server/index.js` and the routers it mounts. Do not edit by hand.',
  );
  lines.push('');
  lines.push(
    'Each router line shows its mount path, any middleware applied at that level in brackets, and the source file. Endpoints below a router are listed in registration order with their full path.',
  );
  lines.push('');
  lines.push('```text');
  lines.push('app  ← api/server/index.js');
  for (const endpoint of endpoints) {
    lines.push(`    ${endpoint.method.toUpperCase().padEnd(6)} ${endpoint.path}`);
  }
  for (const mount of mounts) {
    if (mount.ref) {
      const node = await walkRouter(mount.path, mount.ref, mount.middleware);
      renderNode(node, '', '    ', lines);
      continue;
    }
    lines.push(`    ${mount.path}  [${[...mount.middleware, mount.label].join(', ')}]`);
  }
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const tree = await buildTree();
  const flag = process.argv[2];

  if (flag === '--write') {
    await writeFile(OUTPUT, tree);
    console.log(`Wrote ${toRepoPath(OUTPUT)}`);
    return;
  }

  if (flag === '--check') {
    const current = existsSync(OUTPUT) ? await readFile(OUTPUT, 'utf8') : '';
    if (current !== tree) {
      console.error(`${toRepoPath(OUTPUT)} is stale. Run: node scripts/routes.mts --write`);
      process.exit(1);
    }
    console.log(`${toRepoPath(OUTPUT)} is up to date`);
    return;
  }

  process.stdout.write(tree);
}

await main();
