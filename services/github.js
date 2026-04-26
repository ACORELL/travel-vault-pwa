// GitHub Contents API wrapper.
// Reads PAT and repo from settings.js. Base64 encode/decode lives only here.
// Throws typed errors so callers can branch (auth → settings, conflict → surface,
// network → queue).

import { get, GITHUB_PAT, GITHUB_REPO } from './settings.js';

export class GitHubAuthError     extends Error {}
export class GitHubConflictError extends Error {}
export class GitHubNotFoundError extends Error {}

const API = 'https://api.github.com';

function auth() {
  const token = get(GITHUB_PAT);
  const repo  = get(GITHUB_REPO);
  if (!token) throw new GitHubAuthError('GitHub PAT not configured');
  if (!repo)  throw new GitHubAuthError('GitHub repo not configured');
  return { token, repo };
}

function url(repo, path) {
  // Path segments are encoded; slashes between segments are kept.
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${API}/repos/${repo}/contents/${encoded}`;
}

function headers(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// UTF-8-safe base64 for arbitrary content. btoa() only handles Latin-1, so we
// route bytes through TextEncoder for strings (handles emoji, accents) and
// arrayBuffer() for Blobs / typed arrays (handles thumbnail binaries).
async function encodeContent(content) {
  let bytes;
  if (typeof content === 'string') {
    bytes = new TextEncoder().encode(content);
  } else if (content instanceof Blob) {
    bytes = new Uint8Array(await content.arrayBuffer());
  } else if (content instanceof Uint8Array) {
    bytes = content;
  } else if (content instanceof ArrayBuffer) {
    bytes = new Uint8Array(content);
  } else {
    throw new Error('putFile: unsupported content type');
  }
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function decodeBase64(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function throwForStatus(res, path) {
  if (res.status === 401) throw new GitHubAuthError(`401 on ${path}`);
  if (res.status === 404) throw new GitHubNotFoundError(`404 on ${path}`);
  if (res.status === 409 || res.status === 422) {
    throw new GitHubConflictError(`${res.status} on ${path}`);
  }
  throw new Error(`GitHub ${res.status} on ${path}`);
}

export async function getFile(path) {
  const { token, repo } = auth();
  const res = await fetch(url(repo, path), { headers: headers(token) });
  if (!res.ok) throwForStatus(res, path);
  const json = await res.json();
  return { content: decodeBase64(json.content), sha: json.sha };
}

// Fetch a binary file (e.g. a thumbnail blob) via the Contents API.
// GitHub returns base64 in the `content` field for files <= 1 MB. Our
// thumbnails are ~200 KB so we stay comfortably under that.
export async function getBinary(path, mime = 'application/octet-stream') {
  const { token, repo } = auth();
  const res = await fetch(url(repo, path), { headers: headers(token) });
  if (!res.ok) throwForStatus(res, path);
  const json = await res.json();
  const bin = atob((json.content || '').replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { blob: new Blob([bytes], { type: mime }), sha: json.sha };
}

export async function listDir(path) {
  const { token, repo } = auth();
  const res = await fetch(url(repo, path), { headers: headers(token) });
  if (!res.ok) throwForStatus(res, path);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error(`listDir: ${path} is not a directory`);
  return json.map(({ name, path, sha, type }) => ({ name, path, sha, type }));
}

async function putOnce(repo, token, path, content, message, sha) {
  const body = { message, content: await encodeContent(content) };
  if (sha) body.sha = sha;
  const res = await fetch(url(repo, path), {
    method: 'PUT',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

export async function putFile(path, content, message, sha) {
  const { token, repo } = auth();
  let res = await putOnce(repo, token, path, content, message, sha);

  // Conflict: re-fetch sha and retry once with the same content. Used by
  // create-only callers (queue.js raw captures, thumb uploads) where the
  // local content is authoritative — second device just hasn't seen it yet.
  if (res.status === 409 || res.status === 422) {
    let currentSha;
    try {
      ({ sha: currentSha } = await getFile(path));
    } catch (e) {
      if (e instanceof GitHubNotFoundError) currentSha = undefined;
      else throw e;
    }
    res = await putOnce(repo, token, path, content, message, currentSha);
    if (res.status === 409 || res.status === 422) {
      throw new GitHubConflictError(`${res.status} on ${path} after retry`);
    }
  }

  if (!res.ok) throwForStatus(res, path);
  const json = await res.json();
  return { sha: json.content?.sha };
}

// putFileExact: PUT with sha and throw GitHubConflictError on the first
// 409/422. timeline.js atomicEdit needs this so it can refetch the file and
// re-run its mutator on the fresh remote content rather than overwriting
// another device's concurrent write with stale local content.
export async function putFileExact(path, content, message, sha) {
  const { token, repo } = auth();
  const res = await putOnce(repo, token, path, content, message, sha);
  if (res.status === 409 || res.status === 422) {
    throw new GitHubConflictError(`${res.status} on ${path}`);
  }
  if (!res.ok) throwForStatus(res, path);
  const json = await res.json();
  return { sha: json.content?.sha };
}

export async function deleteFile(path, sha, message) {
  const { token, repo } = auth();
  const res = await fetch(url(repo, path), {
    method: 'DELETE',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha }),
  });
  if (!res.ok) throwForStatus(res, path);
}
