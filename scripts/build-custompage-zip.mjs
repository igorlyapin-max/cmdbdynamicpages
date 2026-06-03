import fs from 'node:fs';
import path from 'node:path';

const sourcePath = path.resolve('src/CmdbDynamicPages.js');
const outputPath = path.resolve('dist/cmdbdynamicpages-custompage.zip');
const zipEntryName = 'CmdbDynamicPages.js';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function header(size) {
  return Buffer.alloc(size);
}

function buildZip(entryName, content, modifiedAt) {
  const fileName = Buffer.from(entryName, 'utf8');
  const crc = crc32(content);
  const stamp = dosTimestamp(modifiedAt);
  const localHeader = header(30);

  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(10, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt16LE(stamp.time, 10);
  localHeader.writeUInt16LE(stamp.date, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(content.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(fileName.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const centralHeader = header(46);
  const centralOffset = localHeader.length + fileName.length + content.length;
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(10, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt16LE(stamp.time, 12);
  centralHeader.writeUInt16LE(stamp.date, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(content.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(fileName.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  centralHeader.writeUInt32LE(0, 42);

  const end = header(22);
  const centralSize = centralHeader.length + fileName.length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([
    localHeader,
    fileName,
    content,
    centralHeader,
    fileName,
    end
  ]);
}

const source = fs.readFileSync(sourcePath);
const modifiedAt = fs.statSync(sourcePath).mtime;
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, buildZip(zipEntryName, source, modifiedAt));
console.log(`Wrote ${path.relative(process.cwd(), outputPath)} (${source.length} bytes payload).`);
