/* ============================================================
 * 商店上传包构建脚本（开发工具，不随商店包分发）
 * 运行：node tools/build_zip.mjs
 * 产物：store/dist/video-sniffer-<version>.zip
 *
 * 说明：
 *  - 只打包扩展运行所需的文件，排除 test/ tools/ store/ 及各类开发文件，
 *    避免把测试脚本、截图生成器、上架材料一并上传（这些文件既无必要，也可能引起审核疑问）。
 *  - 自实现最小 ZIP 写入器（deflate，UTF-8 文件名），不依赖任何第三方库，
 *    确保路径分隔符统一为 "/"，在 Windows 上打包也不会出现反斜杠问题。
 * ============================================================ */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { join, dirname, relative, extname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'store', 'dist');

/* 打包白名单：扩展运行必需的目录与文件 */
const INCLUDE_DIRS = ['icons', 'lib', 'offscreen', 'popup'];
const INCLUDE_FILES = ['manifest.json', 'background.js', 'content.js', 'policy.html', 'privacy.html'];
/* 额外的顶层文件（可选，存在才打包） */
const OPTIONAL_FILES = ['README.md'];
/* 排除规则：任何路径命中即跳过 */
const EXCLUDE_RE = /(^|\/)(node_modules|\.git|\.workbuddy|test|tools|store)(\/|$)|(^|\/)\.|\.(log|tmp|zip)$|(^|\/)_/;

/* ---------------- CRC32 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/* ---------------- 最小 ZIP 写入器 ---------------- */
function dosTime(d) {
  return ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xffff;
}
function dosDate(d) {
  return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
}

function buildZip(entries) {
  /* entries: [{ path, data:Buffer, mtime:Date }] —— path 使用 "/" 分隔 */
  const now = new Date();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.path, 'utf8');
    const raw = e.data;
    const comp = deflateRawSync(raw, { level: 9 });
    /* 压缩后更大时改用 store（method 0） */
    const useStore = comp.length >= raw.length;
    const body = useStore ? raw : comp;
    const method = useStore ? 0 : 8;
    const crc = crc32(raw);
    const t = e.mtime || now;
    const time = dosTime(t), date = dosDate(t);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // version needed
    lh.writeUInt16LE(0x0800, 6);        // flags: UTF-8 文件名
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);            // extra len
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);            // version made by
    ch.writeUInt16LE(20, 6);            // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);            // extra
    ch.writeUInt16LE(0, 32);            // comment
    ch.writeUInt16LE(0, 34);            // disk
    ch.writeUInt16LE(0, 36);            // internal attr
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attr
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(locals), cdBuf, eocd]);
}

/* ---------------- 收集文件 ---------------- */
function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = relative(ROOT, abs).split('\\').join('/');
    if (EXCLUDE_RE.test(rel)) continue;
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else if (st.isFile()) out.push({ abs, rel, size: st.size, mtime: st.mtime });
  }
}

function main() {
  /* 1. 读取版本号 */
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const version = manifest.version || '0.0.0';

  /* 2. 收集待打包文件 */
  const files = [];
  for (const d of INCLUDE_DIRS) {
    const abs = join(ROOT, d);
    if (!existsSync(abs)) { console.log('  ⚠ 缺少目录: ' + d); continue; }
    walk(abs, files);
  }
  for (const f of INCLUDE_FILES.concat(OPTIONAL_FILES)) {
    const abs = join(ROOT, f);
    if (!existsSync(abs)) { console.log('  ⚠ 缺少文件: ' + f); continue; }
    const rel = f.split('\\').join('/');
    if (EXCLUDE_RE.test(rel)) continue;
    const st = statSync(abs);
    files.push({ abs, rel, size: st.size, mtime: st.mtime });
  }

  /* 3. 断言：manifest.json 必须在包根目录 */
  if (!files.some((f) => f.rel === 'manifest.json')) throw new Error('manifest.json 未在包根目录，打包中止');

  /* 4. 写入 */
  mkdirSync(OUT_DIR, { recursive: true });
  const entries = files.map((f) => ({ path: f.rel, data: readFileSync(f.abs), mtime: f.mtime }));
  const zip = buildZip(entries);
  const outFile = join(OUT_DIR, 'video-sniffer-' + version + '.zip');
  writeFileSync(outFile, zip);

  /* 5. 输出清单 */
  console.log('打包目录: ' + OUT_DIR);
  console.log('输出文件: video-sniffer-' + version + '.zip  (' + (zip.length / 1024).toFixed(0) + ' KB)\n');
  console.log('包含 ' + files.length + ' 个文件:');
  let total = 0;
  for (const f of files) {
    total += f.size;
    console.log('  ' + String((f.size / 1024).toFixed(1)).padStart(8) + ' KB  ' + f.rel);
  }
  console.log('\n原始大小合计: ' + (total / 1024).toFixed(0) + ' KB');

  /* 6. 自检：必须在 EOCD 中找到条目数，且不包含被排除目录 */
  const bad = files.filter((f) => /(^|\/)(test|tools|store)(\/|$)/.test(f.rel));
  if (bad.length) throw new Error('包内出现应排除的路径: ' + bad.map((f) => f.rel).join(', '));
  if (zip.toString('latin1', 0, 4) !== 'PK\x03\x04') throw new Error('ZIP 头校验失败');
  const eocdIdx = zip.length - 22;
  if (zip.readUInt32LE(eocdIdx) !== 0x06054b50) throw new Error('EOCD 校验失败');
  if (zip.readUInt16LE(eocdIdx + 10) !== files.length) throw new Error('ZIP 条目数不匹配');

  console.log('\n✓ 自检通过：ZIP 结构有效，条目数与文件清单一致，无 test/tools/store 目录残留');
  console.log('  上传路径: ' + outFile);
}

main();
