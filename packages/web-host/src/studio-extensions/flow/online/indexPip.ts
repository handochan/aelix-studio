import { createReadStream } from 'node:fs';
import { ExtensionFailure } from '../../types.js';

export const INDEX_RESPONSE_LIMIT = 8 * 1024 * 1024;
export const RESOLUTION_REPORT_LIMIT = 1024 * 1024;
export const PIP_RESPONSE_LIMIT_EXIT = 44;

// The bundled pip still owns selection, transport, certificates, proxy and hash verification.
// Cap every decoded Simple API body (including redirects) before requests joins its chunks.
export const BOUNDED_INDEX_PIP = `
# aelix-studio-bounded-index-pip
import builtins
import contextlib
import sys
from pip._internal.cli.main import main
from pip._internal.commands import install
from pip._internal.exceptions import InstallationError
from pip._internal.operations.prepare import RequirementPreparer
from pip._vendor.requests.models import Response

index_limit, report_limit = map(int, sys.argv[1:3])
args = sys.argv[3:]
# Pass the private URL unchanged to pip in-process. It never becomes a command-line argument.
if args == ["install", "--studio-archive-stdin"]:
    args[-1] = sys.stdin.readline().rstrip("\\n")

exceeded = False

def exceed_size_limit():
    global exceeded
    exceeded = True
    raise InstallationError("Studio extension upgrade response exceeded its size limit")

original_chunks = Response.iter_content
def bounded_chunks(response, chunk_size=1, decode_unicode=False):
    request = response.request
    simple = request is not None and "application/vnd.pypi.simple" in request.headers.get("Accept", "")
    if not simple:
        yield from original_chunks(response, chunk_size, decode_unicode)
        return
    total = 0
    for chunk in original_chunks(response, min(chunk_size or 65536, 65536), False):
        total += len(chunk)
        if total > index_limit:
            exceed_size_limit()
        yield chunk

Response.iter_content = bounded_chunks

if "--report" in args:
    report = args[args.index("--report") + 1]
    # Force a complete artifact in the probe so pip computes SHA256 if the link has no hash.
    RequirementPreparer._fetch_metadata_only = lambda *args: None

    class BoundedWriter:
        def __init__(self, file):
            self.file = file
            self.total = 0
        def write(self, text):
            self.total += len(text.encode("utf-8"))
            if self.total > report_limit:
                exceed_size_limit()
            return self.file.write(text)

    @contextlib.contextmanager
    def bounded_open(file, *flags, **kwargs):
        with builtins.open(file, *flags, **kwargs) as stream:
            yield BoundedWriter(stream) if file == report else stream

    install.open = bounded_open

status = main(args)
sys.exit(${PIP_RESPONSE_LIMIT_EXIT} if exceeded else status)
`;

export type ResolvedArchive = { version: string; requirement: string; privateFields: string[] };

type RequestedArchive = {
  requested?: unknown;
  is_yanked?: unknown;
  metadata?: { name?: unknown; version?: unknown };
  download_info?: { url?: unknown; archive_info?: { hashes?: Record<string, unknown> } };
};

export async function readResolutionReport(file: string, deadline: number, cancelled?: AbortSignal): Promise<unknown> {
  const check = (): void => {
    if (cancelled?.aborted) throw new ExtensionFailure('CANCELLED');
    if (performance.now() >= deadline) throw new ExtensionFailure('TIMEOUT');
  };
  check();
  const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())));
  const signal = cancelled ? AbortSignal.any([cancelled, timeout]) : timeout;
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    const stream = createReadStream(file, { end: RESOLUTION_REPORT_LIMIT, signal });
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      length += bytes.length;
      if (length > RESOLUTION_REPORT_LIMIT) throw new ExtensionFailure('UPGRADE_RESPONSE_TOO_LARGE');
      chunks.push(bytes);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    check();
    return parsed;
  } catch (error) {
    check();
    if (timeout.aborted) throw new ExtensionFailure('TIMEOUT');
    if (error instanceof ExtensionFailure) throw error;
    throw new ExtensionFailure('REQUEST_MISMATCH', ['pip did not provide a valid resolution report']);
  }
}

export function requestedArchive(report: unknown): RequestedArchive {
  const parsed = report as { version?: unknown; install?: RequestedArchive[] } | null;
  if (
    parsed?.version !== '1' ||
    !Array.isArray(parsed.install) ||
    parsed.install.length !== 1 ||
    parsed.install[0]?.requested !== true ||
    parsed.install[0]?.is_yanked !== false
  )
    throw new ExtensionFailure('REQUEST_MISMATCH', ['pip did not resolve a single available archive']);
  return parsed.install[0];
}

export function archiveRequirement(name: string, archive: RequestedArchive): Omit<ResolvedArchive, 'version'> {
  const value = archive.download_info?.url;
  const url = typeof value === 'string' && value.length <= 4096 && !/[\s\\]/.test(value) ? URL.parse(value) : null;
  const hashes = archive.download_info?.archive_info?.hashes;
  const hash = [
    ['sha256', 64],
    ['sha384', 96],
    ['sha512', 128],
  ] as const;
  const supported = hash.find(([algorithm, length]) => {
    const digest = hashes?.[algorithm];
    return typeof digest === 'string' && digest.length === length && /^[a-f0-9]+$/i.test(digest);
  });
  if (
    !url ||
    !['https:', 'http:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    !supported
  )
    throw new ExtensionFailure('REQUEST_MISMATCH', ['pip did not identify a verifiable archive']);
  const algorithm = supported[0];
  url.hash = `${algorithm}=${String(hashes?.[algorithm]).toLowerCase()}`;
  return { requirement: `${name} @ ${url.href}`, privateFields: [url.search.slice(1), url.hash.slice(1)] };
}
