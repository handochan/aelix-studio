/**
 * Wheels for the Studio extension helper tests, built in memory. They are real wheels:
 * the integration test installs them with pip in a copy of the bundled runtime.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** A zip archive with the members in the given order: stored, or deflated when `deflate` is set. */
export function zip(members: [name: string, content: string | Buffer][], deflate = false): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of members) {
    const plain = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const data = deflate ? deflateRawSync(plain) : plain;
    const encoded = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(0x21, 12); // 1980-01-01, the earliest date the format has
    local.writeUInt32LE(crc32(plain), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(encoded.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(deflate ? 8 : 0, 10);
    entry.writeUInt16LE(0x21, 14);
    local.copy(entry, 16, 14, 30);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, encoded, data);
    directory.push(entry, encoded);
    offset += local.length + encoded.length + data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

export type WheelSpec = {
  /** Distribution name. */
  name: string;
  version?: string;
  /** Import name; the distribution name with `_` by default. */
  module?: string;
  requires?: string[];
  /** Adds an `aelix.extensions` entry point, a `setup()` and a manifest that binds. Default true. */
  extension?: boolean;
  /** Set false to leave the manifest (`aelix-plugin.toml`) out of an extension. */
  manifest?: boolean;
  /** Python statements at module level, before `setup`. */
  prelude?: string;
  /** Python statements inside `setup(aelix)`, before the command is registered. */
  setup?: string;
  /** `[console_scripts]` lines, for example `tool = module:main`. */
  scripts?: string[];
  /** Further members, by archive path. */
  files?: Record<string, string>;
  /** Replaces the generated `METADATA`. */
  metadata?: string;
  /** Replaces the generated file name. */
  filename?: string;
  /** Deflate the members, as wheels built by real tools are. */
  deflate?: boolean;
};

const manifest = (name: string, version: string, module: string): string => `[plugin]
id = "${name}"
name = "${name}"
version = "${version}"
description = "fixture"
authors = ["fixture"]
repository = "https://example.invalid/${name}"
license = "Apache-2.0"
[plugin.api]
level = 1
min_level = 1
[plugin.entry]
python = "${module}:setup"
[capabilities]
shell_exec = false
net = false
ui_tui_trusted = false
[activation]
on_startup_finished = true
`;

/** Build a wheel: its file name and bytes. */
export function buildWheel(spec: WheelSpec): { filename: string; data: Buffer } {
  const version = spec.version ?? '0.1.0';
  const distribution = spec.name.replace(/[-.]/g, '_');
  const module = spec.module ?? distribution;
  const extension = spec.extension ?? true;
  const info = `${distribution}-${version}.dist-info`;
  const files = new Map<string, string>();
  files.set(
    `${module}/__init__.py`,
    [
      spec.prelude ?? '',
      'def setup(aelix):',
      ...(spec.setup ?? '').split('\n').map((line) => (line ? `    ${line}` : '')),
      `    aelix.register_command("${spec.name}-cmd", handler=lambda *a, **k: "${spec.name} ran", description="fixture")`,
      '',
      'def main():',
      `    print("${spec.name} console script ran")`,
      '',
    ].join('\n')
  );
  if (extension && spec.manifest !== false)
    files.set(`${module}/aelix-plugin.toml`, manifest(spec.name, version, module));
  for (const [name, content] of Object.entries(spec.files ?? {})) files.set(name, content);
  files.set(
    `${info}/METADATA`,
    spec.metadata ??
      `Metadata-Version: 2.1\nName: ${spec.name}\nVersion: ${version}\n` +
        (spec.requires ?? []).map((requirement) => `Requires-Dist: ${requirement}\n`).join('')
  );
  files.set(
    `${info}/WHEEL`,
    'Wheel-Version: 1.0\nGenerator: studio-fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n'
  );
  const points =
    (spec.scripts?.length ? `[console_scripts]\n${spec.scripts.join('\n')}\n` : '') +
    (extension ? `[aelix.extensions]\n${spec.name} = ${module}:setup\n` : '');
  if (points) files.set(`${info}/entry_points.txt`, points);
  const record = [...files].map(([name, content]) => {
    const digest = createHash('sha256').update(content).digest('base64url');
    return `${name},sha256=${digest},${Buffer.byteLength(content)}`;
  });
  files.set(`${info}/RECORD`, [...record, `${info}/RECORD,,`].join('\n') + '\n');
  return {
    filename: spec.filename ?? `${distribution}-${version}-py3-none-any.whl`,
    data: zip([...files], spec.deflate),
  };
}

/** Write a wheel into `directory` and return its path. */
export async function writeWheel(directory: string, spec: WheelSpec): Promise<string> {
  const { filename, data } = buildWheel(spec);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, filename);
  await writeFile(file, data);
  return file;
}
