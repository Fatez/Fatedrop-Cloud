import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} is required`);
  return value.trim();
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180);
}

async function readSnapshot(path, expected) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed?.schemaVersion !== 1) return null;
    if (parsed?.namespace !== expected.namespace) return null;
    if (parsed?.sourceVersion !== expected.sourceVersion) return null;
    if (parsed?.method !== expected.method) return null;
    if (parsed?.argsDigest !== expected.argsDigest) return null;
    if (parsed?.payloadDigest !== digest(parsed.payload)) return null;
    return parsed.payload;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeSnapshot(path, metadata, payload) {
  await mkdir(dirname(path), { recursive: true });
  const body = JSON.stringify({
    schemaVersion: 1,
    ...metadata,
    payloadDigest: digest(payload),
    payload,
  });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, path);
}

export function withVersionedSourceSnapshots(client, {
  directory,
  namespace,
  sourceVersion,
} = {}) {
  if (!client || typeof client !== 'object') throw new TypeError('client is required');
  const root = requireText(directory, 'directory');
  const ns = requireText(namespace, 'namespace');
  const version = requireText(sourceVersion, 'sourceVersion');
  const wrapped = {};

  for (const [method, fn] of Object.entries(client)) {
    if (typeof fn !== 'function') {
      wrapped[method] = fn;
      continue;
    }

    wrapped[method] = async (...args) => {
      const argsDigest = digest(args);
      const path = join(root, safeName(ns), safeName(version), safeName(method), `${argsDigest}.json`);
      const metadata = { namespace: ns, sourceVersion: version, method, argsDigest };
      const hit = await readSnapshot(path, metadata);
      if (hit !== null) return hit;

      const payload = await fn.apply(client, args);
      await writeSnapshot(path, metadata, payload);
      return payload;
    };
  }

  return Object.freeze(wrapped);
}
