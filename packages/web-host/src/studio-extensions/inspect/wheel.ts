import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { canonicalName, parseExtensionEntries, readIdentity } from './metadata.js';
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
  const directory = await readAt(handle, directoryOffset, directorySize);
  const members: Member[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== DIRECTORY_ENTRY)
      throw new WheelError('the archive directory is damaged');
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    members.push({
      name: directory.toString('utf8', cursor + 46, cursor + 46 + nameLength),
      method: directory.readUInt16LE(cursor + 10),
      compressedSize: directory.readUInt32LE(cursor + 20),
      size: directory.readUInt32LE(cursor + 24),
      offset: directory.readUInt32LE(cursor + 42),
    });
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

/** Where a wheel member lands relative to `site-packages`, or undefined when it lands elsewhere. */
function sitePath(member: string): string[] | undefined {
  const parts = member.split('/').filter((part) => part !== '');
  if (parts.length === 0) return undefined;
  if (parts[0].endsWith('.dist-info')) return undefined;
  if (!parts[0].endsWith('.data')) return parts;
  if (parts[1] === 'purelib' || parts[1] === 'platlib') return parts.slice(2);
  // The `data` scheme installs under the environment prefix, which contains site-packages.
  const site = parts.findIndex((part) => part.toLowerCase() === 'site-packages');
  return parts[1] === 'data' && site > 1 ? parts.slice(site + 1) : undefined;
}

/**
 * Read what a wheel declares, from the archive alone. Nothing in it is imported or run.
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
    const files = members.filter((member) => !member.name.endsWith('/'));
    // Python's zipfile reads the last member of a name; refuse rather than guess which one counts.
    if (new Set(files.map((member) => member.name)).size !== files.length)
      throw new WheelError('the archive holds two members with the same name');
    const metadata = files.filter((member) => /^[^/]+\.dist-info\/METADATA$/.test(member.name));
    if (metadata.length !== 1) throw new WheelError('the wheel must hold exactly one .dist-info/METADATA');
    const info = metadata[0].name.slice(0, -'/METADATA'.length);
    const identity = readIdentity(await readText(handle, metadata[0]));
    if (!identity) throw new WheelError('METADATA has no Name or Version');
    const declared = parseVersion(identity.version);
    const named = parseVersion(tags[1]);
    const sameVersion = declared && named ? compareVersions(declared, named) === 0 : identity.version === tags[1];
    if (canonicalName(tags[0]) !== identity.name || !sameVersion)
      throw new WheelError('the file name does not match the Name and Version in METADATA');
    const entryPoints = files.find((member) => member.name === `${info}/entry_points.txt`);
    const extensions = entryPoints
      ? parseExtensionEntries(await readText(handle, entryPoints))
      : new Map<string, string>();
    const top = new Set<string>();
    const startup = new Set<string>();
    for (const member of files) {
      const parts = sitePath(member.name);
      if (!parts || parts.length === 0) continue;
      top.add(topLevelName(parts[0]));
      if (isStartupEntry(parts[0])) startup.add(member.name);
    }
    return {
      file,
      filename,
      name: identity.name,
      version: identity.version,
      requires: identity.requires,
      extensions,
      topLevel: [...top].toSorted(),
      startupFiles: [...startup].toSorted(),
    };
  } finally {
    await handle.close();
  }
}
