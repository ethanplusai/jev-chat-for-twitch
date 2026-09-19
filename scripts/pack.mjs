/** Zip extension/ into dist/jev-chat-for-twitch-<manifest version>.zip.
 * No dependencies: a minimal ZIP writer using the store method and node:zlib's crc32.
 * Entries are named extension/<file>, so the archive unzips to a folder Chrome can load unpacked. */
import {readdir, readFile, mkdir, writeFile, stat} from 'node:fs/promises';
import {crc32} from 'node:zlib';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE = path.join(root, 'extension');
const OUT_DIR = path.join(root, 'dist');

/** Every file under extension/, sorted, as posix-style archive paths. */
async function collect(dir, prefix = 'extension') {
  const entries = await readdir(dir, {withFileTypes: true});
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await collect(full, name));
    else if (entry.isFile()) files.push({name, full});
  }
  return files;
}

/** MS-DOS time and date, which is what a ZIP local header carries. */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function localHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);          // version needed
  head.writeUInt16LE(0, 6);           // flags
  head.writeUInt16LE(0, 8);           // method 0, stored
  head.writeUInt16LE(entry.time, 10);
  head.writeUInt16LE(entry.date, 12);
  head.writeUInt32LE(entry.crc, 14);
  head.writeUInt32LE(entry.size, 18);
  head.writeUInt32LE(entry.size, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, name]);
}

function centralHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0);
  head.writeUInt16LE(20, 4);          // version made by
  head.writeUInt16LE(20, 6);          // version needed
  head.writeUInt16LE(0, 8);
  head.writeUInt16LE(0, 10);
  head.writeUInt16LE(entry.time, 12);
  head.writeUInt16LE(entry.date, 14);
  head.writeUInt32LE(entry.crc, 16);
  head.writeUInt32LE(entry.size, 20);
  head.writeUInt32LE(entry.size, 24);
  head.writeUInt16LE(name.length, 28);
  head.writeUInt16LE(0, 30);          // extra
  head.writeUInt16LE(0, 32);          // comment
  head.writeUInt16LE(0, 34);          // disk
  head.writeUInt16LE(0, 36);          // internal attributes
  head.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  head.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([head, name]);
}

function endRecord(count, size, offset) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return end;
}

export async function pack() {
  const manifest = JSON.parse(await readFile(path.join(SOURCE, 'manifest.json'), 'utf8'));
  const files = await collect(SOURCE);
  if (!files.length) throw new Error('extension/ has no files to pack.');
  const stamp = dosStamp(new Date());
  const parts = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const body = await readFile(file.full);
    const entry = {name: file.name, crc: crc32(body) >>> 0, size: body.length, offset, ...stamp};
    const head = localHeader(entry);
    parts.push(head, body);
    central.push(centralHeader(entry));
    offset += head.length + body.length;
  }
  const directory = Buffer.concat(central);
  const zip = Buffer.concat([...parts, directory, endRecord(files.length, directory.length, offset)]);
  await mkdir(OUT_DIR, {recursive: true});
  const out = path.join(OUT_DIR, `jev-chat-for-twitch-${manifest.version}.zip`);
  await writeFile(out, zip);
  return {path: out, bytes: zip.length, files: files.length};
}

const result = await pack();
const size = (await stat(result.path)).size;
console.log(`${result.path} (${result.files} files, ${size} bytes)`);
