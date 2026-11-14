import { Buffer } from 'node:buffer';
import type { Catalog } from '../shared/catalog.ts';
import { parseCatalog } from '../shared/catalog.ts';

/** GitHub as the catalog database: read products.json, write one atomic commit per change (spec §7). */

const API = 'https://api.github.com';
export const CATALOG_PATH = 'src/data/products.json';
export const PHOTOS_DIR = 'src/assets/products';
const AUTHOR = { name: 'Bot de la Tienda', email: 'bot@tienda-norma.invalid' };

export type GitHubConfig = { token: string; repo: string; branch: string; fetchFn?: typeof fetch };
/** New content, an already-uploaded blob (see uploadBlob), or a deletion. */
export type FileChange =
  | { path: string; content: Uint8Array | string }
  | { path: string; blobSha: string }
  | { path: string; delete: true };

function gh(cfg: GitHubConfig, method: string, path: string, body?: unknown, accept = 'application/vnd.github+json') {
  return (cfg.fetchFn ?? fetch)(`${API}/repos/${cfg.repo}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept,
      'user-agent': 'tienda-norma-bot',
      'x-github-api-version': '2022-11-28',
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
}

/** Uploads file content once; the returned blob SHA can be reused across commit retries. */
export async function uploadBlob(cfg: GitHubConfig, content: Uint8Array | string): Promise<string> {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  const blob = await json<{ sha: string }>(
    await gh(cfg, 'POST', '/git/blobs', { content: bytes.toString('base64'), encoding: 'base64' }),
    'blob',
  );
  return blob.sha;
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`GitHub ${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** The branch head and the catalog at that commit. Always fresh: never trust a cached copy. */
export async function readCatalog(cfg: GitHubConfig): Promise<{ headSha: string; catalog: Catalog }> {
  const ref = await json<{ object: { sha: string } }>(await gh(cfg, 'GET', `/git/ref/heads/${cfg.branch}`), 'ref');
  const headSha = ref.object.sha;
  const res = await gh(cfg, 'GET', `/contents/${CATALOG_PATH}?ref=${headSha}`, undefined, 'application/vnd.github.raw+json');
  if (!res.ok) throw new Error(`GitHub catalog: HTTP ${res.status}`);
  return { headSha, catalog: parseCatalog(JSON.parse(await res.text())) };
}

/** One commit on top of `baseSha`. Returns 'conflict' when the branch moved meanwhile (not a fast-forward). */
export async function commitFiles(
  cfg: GitHubConfig,
  baseSha: string,
  changes: FileChange[],
  message: string,
): Promise<'ok' | 'conflict'> {
  const base = await json<{ tree: { sha: string } }>(await gh(cfg, 'GET', `/git/commits/${baseSha}`), 'base commit');

  const tree: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = [];
  for (const change of changes) {
    const sha =
      'delete' in change ? null : 'blobSha' in change ? change.blobSha : await uploadBlob(cfg, change.content);
    tree.push({ path: change.path, mode: '100644', type: 'blob', sha });
  }

  const newTree = await json<{ sha: string }>(
    await gh(cfg, 'POST', '/git/trees', { base_tree: base.tree.sha, tree }),
    'tree',
  );
  const commit = await json<{ sha: string }>(
    await gh(cfg, 'POST', '/git/commits', {
      message,
      tree: newTree.sha,
      parents: [baseSha],
      author: { ...AUTHOR, date: new Date().toISOString() },
    }),
    'commit',
  );
  const res = await gh(cfg, 'PATCH', `/git/refs/heads/${cfg.branch}`, { sha: commit.sha, force: false });
  if (res.status === 422) return 'conflict';
  await json(res, 'update ref');
  return 'ok';
}
