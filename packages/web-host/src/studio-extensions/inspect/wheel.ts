import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { canonicalName, parseExtensionEntries, parseScriptNames, readIdentity } from './metadata.js';
import { parseVersion, compareVersions } from './version.js';

/** A wheel that cannot be read as one. The message says why, in plain English. */
export class WheelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WheelError';
  }
}

type Member = { name: string; method: number; compressedSize: number; size: number; offset: number };

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
/** The end record is 22 bytes plus a comment of at most 65535. */
const TAIL_BYTES = 22 + 0xffff;
/** Largest text member this reads into memory. */
const TEXT_LIMIT = 8 * 1024 * 1024;
/** Largest central directory this reads into memory; 65,535 entries fit many times over. */
const DIRECTORY_LIMIT = 32 * 1024 * 1024;
/** Largest archive: the format without zip64 cannot describe more. */
const ARCHIVE_LIMIT = 0xffffffff;
/** Largest total of the declared member sizes: what the installer would write to disk. */
const INSTALLED_LIMIT = 4 * 1024 ** 3;

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new WheelError('the archive is truncated');
  return buffer;
}

/** List the members from the central directory, reading only the end of the file. */
async function readDirectory(handle: FileHandle): Promise<Member[]> {
  const { size } = await handle.stat();
  if (size < 22) throw new WheelError('the file is not a zip archive');
  if (size > ARCHIVE_LIMIT) throw new WheelError('the archive is too large to inspect');
  const tailLength = Math.min(size, TAIL_BYTES);
  const tail = await readAt(handle, size - tailLength, tailLength);
  let end = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === END_OF_DIRECTORY) {
      end = index;
      break;
    }
  }
  if (end < 0) throw new WheelError('the file is not a zip archive');
  const count = tail.readUInt16LE(end + 10);
  const directorySize = tail.readUInt32LE(end + 12);
  const directoryOffset = tail.readUInt32LE(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff)
    throw new WheelError('zip64 archives are not supported');
  if (directoryOffset + directorySize > size) throw new WheelError('the archive directory is out of range');
  // Checked before anything of that size is allocated: the size is whatever the file claims.
  if (directorySize > DIRECTORY_LIMIT) throw new WheelError('the archive directory is too large to inspect');
  const directory = await readAt(handle, directoryOffset, directorySize);
  const members: Member[] = [];
  let cursor = 0;
  let installed = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== DIRECTORY_ENTRY)
      throw new WheelError('the archive directory is damaged');
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    const member = {
      name: directory.toString('utf8', cursor + 46, cursor + 46 + nameLength),
      method: directory.readUInt16LE(cursor + 10),
      compressedSize: directory.readUInt32LE(cursor + 20),
      size: directory.readUInt32LE(cursor + 24),
      offset: directory.readUInt32LE(cursor + 42),
    };
    installed += member.size;
    if (installed > INSTALLED_LIMIT) throw new WheelError('the archive would unpack to more than this helper installs');
    members.push(member);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}

async function readText(handle: FileHandle, member: Member): Promise<string> {
  if (member.size > TEXT_LIMIT || member.compressedSize > TEXT_LIMIT)
    throw new WheelError(`${member.name} is too large to inspect`);
  const header = await readAt(handle, member.offset, 30);
  if (header.readUInt32LE(0) !== LOCAL_HEADER) throw new WheelError('the archive is damaged');
  const start = member.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const raw = await readAt(handle, start, member.compressedSize);
  if (member.method === 0) return raw.toString('utf8');
  if (member.method !== 8) throw new WheelError(`${member.name} uses an unsupported compression method`);
  try {
    return inflateRawSync(raw, { maxOutputLength: TEXT_LIMIT }).toString('utf8');
  } catch {
    throw new WheelError(`${member.name} cannot be decompressed`);
  }
}

export type WheelFacts = {
  file: string;
  filename: string;
  /** Canonical distribution name. */
  name: string;
  version: string;
  /** `Requires-Dist` values as written. */
  requires: string[];
  /** `aelix.extensions` entries: entry name to object reference. */
  extensions: Map<string, string>;
  /** Names the wheel puts at the top of `site-packages`, lower-cased, without suffix. */
  topLevel: string[];
  /** Members that would run or inject paths when an interpreter with `site` starts. */
  startupFiles: string[];
  /** Names of the scripts the installer would write next to the interpreter. */
  scripts: string[];
};

/** Lower-cased first component of a module or package name at the top of `site-packages`. */
export function topLevelName(entry: string): string {
  return entry.split('.')[0].toLowerCase();
}

/** Whether an entry at the top of `site-packages` is run or read when `site` starts. */
export function isStartupEntry(entry: string): boolean {
  const stem = topLevelName(entry);
  return entry.toLowerCase().endsWith('.pth') || stem === 'sitecustomize' || stem === 'usercustomize';
}

/**
 * Whether a script name is one of the names `python -m venv` gives the interpreter or the
 * installer. A wheel that installs a script of such a name replaces what Studio wrote.
 */
export function isInterpreterName(script: string): boolean {
  return /^(?:pythonw?|pip)(?:\d+(?:\.\d+)?)?(?:\.exe)?$/i.test(script);
}

/**
 * The segments of a member name, or undefined when the name is not a plain relative path.
 * The installer normalizes names, so `./a`, `a//b` and `a/../a` all land on `a`; a name
 * that needs normalizing is a second spelling of some path and is not accepted.
 */
function plainPath(name: string): string[] | undefined {
  if (name.includes('\\') || name.includes('\0')) return undefined;
  const parts = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..') || /^[A-Za-z]:/.test(parts[0]))
    return undefined;
  return parts;
}

type Destination = { area: 'site' | 'scripts' | 'data' | 'headers'; parts: string[] };

/** Where the installer puts a member, or undefined when the member is in no place a wheel may use. */
function destinationOf(parts: string[]): Destination | undefined {
  if (!parts[0].endsWith('.data')) return { area: 'site', parts };
  const [, scheme, ...rest] = parts;
  // A directory entry for the data directory or one of its schemes installs nothing.
  if (rest.length === 0) return scheme === undefined || isScheme(scheme) ? { area: 'data', parts: [] } : undefined;
  if (scheme === 'purelib' || scheme === 'platlib') return { area: 'site', parts: rest };
  if (scheme === 'scripts' || scheme === 'headers') return { area: scheme, parts: rest };
  if (scheme !== 'data') return undefined;
  // The `data` scheme installs under the environment prefix, which holds site-packages and the scripts.
  const site = rest.findIndex((part) => part.toLowerCase() === 'site-packages');
  if (site >= 0 && site < rest.length - 1) return { area: 'site', parts: rest.slice(site + 1) };
  const first = rest[0].toLowerCase();
  if ((first === 'bin' || first === 'scripts') && rest.length > 1) return { area: 'scripts', parts: rest.slice(1) };
  return { area: 'data', parts: rest };
}

const isScheme = (name: string): boolean => ['purelib', 'platlib', 'scripts', 'headers', 'data'].includes(name);

/**
 * Read what a wheel declares, from the archive alone. Nothing in it is imported or run.
 *
 * What is read has to be what gets installed. An archive in which two members reach the
 * same installed path (by another spelling, another case, or through the `.data`
 * directory) is refused: the installer would keep one and this reader might see the other.
 *
 * @throws WheelError when the file is not a wheel this helper can inspect.
 */
export async function readWheel(file: string): Promise<WheelFacts> {
  const filename = path.basename(file);
  const tags = filename.slice(0, -'.whl'.length).split('-');
  if (!filename.toLowerCase().endsWith('.whl') || tags.length < 5 || tags.length > 6)
    throw new WheelError('the file name is not a wheel file name');
  let handle: FileHandle;
  try {
    handle = await open(file, 'r');
  } catch {
    throw new WheelError('the file cannot be opened');
  }
  try {
    const members = await readDirectory(handle);
    const placed = new Map<Member, Destination>();
    const taken = new Set<string>();
    for (const member of members) {
      const parts = plainPath(member.name);
      const destination = parts && destinationOf(parts);
      if (!parts || !destination) throw new WheelError('the archive holds a member with an unusual path');
      if (member.name.endsWith('/')) continue;
      if (destination.parts.length === 0) throw new WheelError('the archive holds a member with an unusual path');
      const key = `${destination.area}/${destination.parts.join('/')}`.normalize('NFC').toLowerCase();
      if (taken.has(key)) throw new WheelError('the archive holds two members that install to the same place');
      taken.add(key);
      const isMetadata = destination.area === 'site' && /\.(?:dist-info|egg-info)$/i.test(destination.parts[0]);
      if (isMetadata && parts[0].endsWith('.data'))
        throw new WheelError('the archive installs distribution metadata through its data directory');
      placed.set(member, destination);
    }
    const files = [...placed.keys()];
    const metadata = files.filter((member) => /^[^/]+\.dist-info\/METADATA$/.test(member.name));
    const infoDirectories = new Set(
      files.map((member) => member.name.split('/')[0]).filter((top) => /\.dist-info$/i.test(top))
    );
    if (metadata.length !== 1 || infoDirectories.size !== 1)
      throw new WheelError('the wheel must hold exactly one .dist-info directory with a METADATA');
    const info = metadata[0].name.slice(0, -'/METADATA'.length);
    const identity = readIdentity(await readText(handle, metadata[0]));
    if (!identity) throw new WheelError('METADATA has no Name or Version');
    const declared = parseVersion(identity.version);
    const named = parseVersion(tags[1]);
    const sameVersion = declared && named ? compareVersions(declared, named) === 0 : identity.version === tags[1];
    if (canonicalName(tags[0]) !== identity.name || !sameVersion)
      throw new WheelError('the file name does not match the Name and Version in METADATA');
    const entryPoints = files.find((member) => member.name === `${info}/entry_points.txt`);
    const points = entryPoints ? await readText(handle, entryPoints) : '';
    const top = new Set<string>();
    const startup = new Set<string>();
    const scripts = new Set(parseScriptNames(points));
    for (const [member, destination] of placed) {
      if (destination.area === 'scripts') scripts.add(destination.parts[0]);
      if (destination.area !== 'site' || member.name.startsWith(`${info}/`)) continue;
      top.add(topLevelName(destination.parts[0]));
      if (isStartupEntry(destination.parts[0])) startup.add(member.name);
    }
    return {
      file,
      filename,
      name: identity.name,
      version: identity.version,
      requires: identity.requires,
      extensions: parseExtensionEntries(points),
      topLevel: [...top].toSorted(),
      startupFiles: [...startup].toSorted(),
      scripts: [...scripts].toSorted(),
    };
  } finally {
    await handle.close();
  }
}
