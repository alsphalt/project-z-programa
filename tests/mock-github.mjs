/**
 * A protocol-accurate subset of the GitHub REST API, used by the import/sync
 * tests.
 *
 * It implements exactly the endpoints the panel calls, with real git blob SHAs
 * (`sha1("blob <len>\0<content>")`) and a ref that only advances through a commit
 * — so a test can prove that a push actually created a commit and moved the
 * branch, not merely that a request was sent.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

function sha1(input) {
  return createHash('sha1').update(input).digest('hex');
}

function blobSha(buffer) {
  return sha1(Buffer.concat([Buffer.from(`blob ${buffer.byteLength}\0`), buffer]));
}

export async function createMockGitHub({
  owner = 'octocat',
  repo = 'darknote-bot',
  branch = 'main',
  files = /** @type {Record<string,string>} */ ({}),
  user = { login: 'octocat', id: 1, name: 'The Octocat', avatar_url: 'https://example.com/a.png' },
} = {}) {
  const state = {
    owner,
    repo,
    branch,
    blobs: new Map(),
    trees: new Map(),
    commits: new Map(),
    head: '',
    counter: 0,
    requests: [],
    failNextRef: false,
  };

  const entries = [];
  for (const [path, content] of Object.entries(files)) {
    const buffer = Buffer.from(content, 'utf8');
    const sha = blobSha(buffer);
    state.blobs.set(sha, buffer);
    entries.push({ path, mode: '100644', type: 'blob', sha, size: buffer.byteLength });
  }
  const baseTree = 'tree-0';
  state.trees.set(baseTree, entries);
  const baseCommit = 'commit-0';
  state.commits.set(baseCommit, {
    sha: baseCommit,
    message: 'initial',
    html_url: `https://github.com/${owner}/${repo}/commit/${baseCommit}`,
    tree: { sha: baseTree },
    parents: [],
  });
  state.head = baseCommit;

  const treeOf = (commitSha) => {
    const commit = state.commits.get(commitSha);
    return state.trees.get(commit?.tree?.sha) ?? [];
  };

  const send = (res, status, body) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-oauth-scopes': 'repo, read:user',
      'x-ratelimit-remaining': '4999',
    });
    res.end(payload);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    state.requests.push(`${req.method} ${path}`);

    if (req.headers.authorization !== 'Bearer test-token-value') {
      return send(res, 401, { message: 'Bad credentials' });
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : {};

    const repoBase = `/repos/${state.owner}/${state.repo}`;

    if (req.method === 'GET' && path === '/user') return send(res, 200, user);

    if (req.method === 'GET' && path === '/user/repos') {
      return send(res, 200, [
        {
          id: 1,
          name: state.repo,
          full_name: `${state.owner}/${state.repo}`,
          owner: { login: state.owner },
          private: true,
          description: 'Darknote bot repository',
          language: 'JavaScript',
          default_branch: state.branch,
          updated_at: '2026-01-02T03:04:05Z',
          pushed_at: '2026-01-02T03:04:05Z',
          permissions: { admin: true, push: true, pull: true },
        },
      ]);
    }

    if (req.method === 'GET' && path === repoBase) {
      return send(res, 200, {
        id: 1,
        name: state.repo,
        full_name: `${state.owner}/${state.repo}`,
        owner: { login: state.owner },
        private: true,
        description: 'Darknote bot repository',
        language: 'JavaScript',
        default_branch: state.branch,
        updated_at: '2026-01-02T03:04:05Z',
        pushed_at: '2026-01-02T03:04:05Z',
        permissions: { admin: true, push: true, pull: true },
      });
    }

    if (req.method === 'GET' && path === `${repoBase}/branches`) {
      return send(res, 200, [{ name: state.branch, commit: { sha: state.head }, protected: false }]);
    }

    if (req.method === 'GET' && path === `${repoBase}/git/ref/heads/${state.branch}`) {
      return send(res, 200, { ref: `refs/heads/${state.branch}`, object: { sha: state.head, type: 'commit' } });
    }

    if (req.method === 'GET' && path.startsWith(`${repoBase}/git/commits/`)) {
      const sha = path.split('/').pop();
      const commit = state.commits.get(sha);
      if (!commit) return send(res, 404, { message: 'Not Found' });
      return send(res, 200, commit);
    }

    if (req.method === 'GET' && path.startsWith(`${repoBase}/git/trees/`)) {
      const sha = path.split('/').pop();
      const tree = state.trees.get(sha);
      if (!tree) return send(res, 404, { message: 'Not Found' });
      return send(res, 200, { sha, tree, truncated: false });
    }

    if (req.method === 'GET' && path.startsWith(`${repoBase}/git/blobs/`)) {
      const sha = path.split('/').pop();
      const buffer = state.blobs.get(sha);
      if (!buffer) return send(res, 404, { message: 'Not Found' });
      return send(res, 200, { sha, size: buffer.byteLength, content: buffer.toString('base64'), encoding: 'base64' });
    }

    if (req.method === 'POST' && path === `${repoBase}/git/blobs`) {
      const buffer = body.encoding === 'base64' ? Buffer.from(body.content, 'base64') : Buffer.from(body.content, 'utf8');
      const sha = blobSha(buffer);
      state.blobs.set(sha, buffer);
      return send(res, 201, { sha });
    }

    if (req.method === 'POST' && path === `${repoBase}/git/trees`) {
      state.counter += 1;
      const base = state.trees.get(body.base_tree) ?? [];
      const replaced = new Set(body.tree.map((entry) => entry.path));
      // `sha: null` removes the path — the documented Git Data API deletion.
      const upserts = body.tree.filter((entry) => entry.sha !== null);
      const merged = [
        ...base.filter((entry) => !replaced.has(entry.path)),
        ...upserts.map((entry) => ({
          path: entry.path,
          mode: entry.mode,
          type: 'blob',
          sha: entry.sha,
          size: state.blobs.get(entry.sha)?.byteLength ?? 0,
        })),
      ];
      const sha = `tree-${state.counter}`;
      state.trees.set(sha, merged);
      return send(res, 201, { sha });
    }

    if (req.method === 'POST' && path === `${repoBase}/git/commits`) {
      state.counter += 1;
      const sha = `commit-${state.counter}`;
      state.commits.set(sha, {
        sha,
        message: body.message,
        html_url: `https://github.com/${state.owner}/${state.repo}/commit/${sha}`,
        tree: { sha: body.tree },
        parents: (body.parents ?? []).map((parent) => ({ sha: parent })),
      });
      return send(res, 201, state.commits.get(sha));
    }

    if (req.method === 'PATCH' && path === `${repoBase}/git/refs/heads/${state.branch}`) {
      if (state.failNextRef) {
        state.failNextRef = false;
        return send(res, 422, { message: 'Update is not a fast forward' });
      }
      if (body.force) return send(res, 422, { message: 'force push is not allowed in this mock' });
      if (!state.commits.has(body.sha)) return send(res, 422, { message: 'Object does not exist' });
      state.head = body.sha;
      return send(res, 200, { ref: `refs/heads/${state.branch}`, object: { sha: state.head, type: 'commit' } });
    }

    if (req.method === 'GET' && path.startsWith(`${repoBase}/contents/`)) {
      const filePath = decodeURIComponent(path.slice(`${repoBase}/contents/`.length));
      const entry = treeOf(state.head).find((item) => item.path === filePath);
      if (!entry) return send(res, 404, { message: 'Not Found' });
      return send(res, 200, { sha: entry.sha, path: filePath, type: 'file' });
    }

    return send(res, 404, { message: `Unhandled ${req.method} ${path}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    /** Simulates a colleague pushing to the same branch. */
    pushRemotely(changed) {
      const entriesNow = treeOf(state.head);
      const replaced = new Set(Object.keys(changed));
      const next = entriesNow.filter((entry) => !replaced.has(entry.path));
      for (const [filePath, content] of Object.entries(changed)) {
        // `null` means the file was deleted in that commit: it is already gone
        // from `next` because it is in `replaced`.
        if (content === null) continue;
        const buffer = Buffer.from(content, 'utf8');
        const sha = blobSha(buffer);
        state.blobs.set(sha, buffer);
        next.push({ path: filePath, mode: '100644', type: 'blob', sha, size: buffer.byteLength });
      }
      state.counter += 1;
      const treeSha = `tree-${state.counter}`;
      state.trees.set(treeSha, next);
      state.counter += 1;
      const commitSha = `commit-${state.counter}`;
      state.commits.set(commitSha, {
        sha: commitSha,
        message: 'remote change',
        html_url: `https://github.com/${state.owner}/${state.repo}/commit/${commitSha}`,
        tree: { sha: treeSha },
        parents: [{ sha: state.head }],
      });
      state.head = commitSha;
      return commitSha;
    },
    contentsAtHead(filePath) {
      const entry = treeOf(state.head).find((item) => item.path === filePath);
      if (!entry) return null;
      return state.blobs.get(entry.sha)?.toString('utf8') ?? null;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
