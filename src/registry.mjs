/**
 * Reading the registry, and reading it about the things people forget to ask.
 *
 * The manifest is only half of what npm knows about a version. The other half
 * is who published it, when, whether it carried provenance, and how big it
 * unpacked to, and those are frequently where the interesting change is. A
 * patch release from a maintainer who has never published before is a fact
 * about the release that no amount of reading its code will tell you.
 */

export class RegistryError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'RegistryError';
    this.status = status;
  }
}

export const DEFAULT_REGISTRY = process.env.npm_config_registry ?? 'https://registry.npmjs.org';

async function getJson(url, { timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });

    if (!response.ok) {
      throw new RegistryError(
        response.status === 404
          ? `the registry has no record of ${decodeURIComponent(new URL(url).pathname.slice(1))}`
          : `the registry answered ${response.status}`,
        { status: response.status },
      );
    }

    return await response.json();
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError(
      error.name === 'AbortError' ? `the registry did not answer within ${timeoutMs}ms` : error.message,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** A scope has to be encoded, and forgetting is the classic 404. */
const encode = (name) => name.replace('/', '%2f');

export async function packument(name, { registry = DEFAULT_REGISTRY } = {}) {
  return getJson(`${registry}/${encode(name)}`);
}

/**
 * The two versions on either side of a change.
 *
 * `from` defaults to the version published immediately before `to`, because
 * the question people actually have is "what did this bump bring", and making
 * them look up the previous number first is friction for no reason.
 */
export function resolveVersions(doc, to, from = null) {
  const versions = Object.keys(doc.versions ?? {});

  if (versions.length === 0) throw new RegistryError(`${doc.name} has no published versions`);

  const target = to === 'latest' || !to ? doc['dist-tags']?.latest : to;

  if (!doc.versions?.[target]) {
    throw new RegistryError(`${doc.name} has no version ${target}`);
  }

  if (from) {
    if (!doc.versions[from]) throw new RegistryError(`${doc.name} has no version ${from}`);
    return { from, to: target };
  }

  // By publish time rather than by semver order, because the release before
  // this one is what the user upgraded from, even when a patch for an older
  // line was published in between with a lower number.
  const times = doc.time ?? {};
  const ordered = versions
    .filter((v) => times[v])
    .sort((a, b) => Date.parse(times[a]) - Date.parse(times[b]));

  const index = ordered.indexOf(target);

  if (index <= 0) throw new RegistryError(`${target} is the first published version of ${doc.name}, so there is nothing to compare it against`);

  return { from: ordered[index - 1], to: target };
}

/**
 * What the registry says about one version, beyond its manifest.
 *
 * Provenance is the one worth calling out. npm records an attestation when a
 * package was published from a workflow rather than a laptop, and a version
 * that had one and then stops having one is a change in how the package is
 * built, which no diff of its files would ever show.
 */
export function releaseFacts(doc, version) {
  const entry = doc.versions?.[version] ?? {};
  const dist = entry.dist ?? {};

  return {
    version,
    publishedAt: doc.time?.[version] ?? null,
    publisher: entry._npmUser?.name ?? null,
    shasum: dist.shasum ?? null,
    integrity: dist.integrity ?? null,
    unpackedSize: dist.unpackedSize ?? null,
    fileCount: dist.fileCount ?? null,
    hasProvenance: Boolean(dist.attestations),
    deprecated: entry.deprecated ?? null,
    tarball: dist.tarball ?? null,
  };
}

/** Everyone the registry currently lists as able to publish. */
export function maintainers(doc) {
  return (doc.maintainers ?? []).map((m) => m.name).filter(Boolean).sort();
}

/**
 * Fetch a tarball into memory.
 *
 * Never to disk and never unpacked by npm, so no lifecycle script of a package
 * under inspection is ever given the chance to run. That is the entire point
 * of doing this by hand.
 */
export async function fetchTarball(url, { timeoutMs = 60000, maxBytes = 200 * 1024 * 1024 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) throw new RegistryError(`the tarball answered ${response.status}`, { status: response.status });

    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      throw new RegistryError(`the tarball is ${length} bytes, above the ${maxBytes} this will download`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > maxBytes) throw new RegistryError('the tarball is larger than this will download');

    return buffer;
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw new RegistryError(error.name === 'AbortError' ? 'the tarball download timed out' : error.message);
  } finally {
    clearTimeout(timer);
  }
}
