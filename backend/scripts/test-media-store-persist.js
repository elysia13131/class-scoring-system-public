/**
 * test-media-store-persist.js —— 媒体登记表持久化恢复单测
 *
 * 场景：用户发图 → 部署重启 → AI 用旧 mediaId 作参考图。
 * 之前媒体表只存内存，重启即丢 → 「参考图解析失败：媒体不存在或已过期」。
 * 修复：_registerMedia 落盘登记表，启动 _loadMediaStore 恢复。
 *
 * 验证：
 *  A. 注册媒体 → 登记表落盘（文件存在）
 *  B. 新实例（模拟重启）→ getMedia 恢复出原条目
 *  C. 磁盘文件被删的条目不恢复（GC 后自然失效）
 *  D. 超 24h TTL 的条目不恢复
 *
 * 运行：node scripts/test-media-store-persist.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const StewardManager = require('../wechat/steward.js');
const UPLOAD_DIR = require('../wechat/geweChannel.js').UPLOAD_DIR;

// 备份真实登记表（本地运行残留）
const storeFile = path.join(__dirname, '..', 'data', 'wechat', 'media-store.json');
const backup = fs.existsSync(storeFile) ? fs.readFileSync(storeFile) : null;

const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? '✓' : '❌'} ${name}${detail !== undefined && detail !== '' ? ' → ' + detail : ''}`);
}

const tmpImg = path.join(UPLOAD_DIR, `test-media-${Date.now()}.jpg`);
const tmpImg2 = path.join(UPLOAD_DIR, `test-media-gc-${Date.now()}.jpg`);
const tmpImg3 = path.join(UPLOAD_DIR, `test-media-ttl-${Date.now()}.jpg`);

(async () => {
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(tmpImg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
    fs.writeFileSync(tmpImg2, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
    fs.writeFileSync(tmpImg3, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));

    const engineStub = { isProcessing: () => false };
    const st1 = new StewardManager({ engine: engineStub });

    // A. 注册 3 条媒体（一条随后删文件、一条改 ts 超 TTL）
    const id1 = st1._registerMedia({ kind: 'image', path: tmpImg, fileName: 'a.jpg', mime: 'image/jpeg', size: 5 }, '612');
    const id2 = st1._registerMedia({ kind: 'image', path: tmpImg2, fileName: 'b.jpg', mime: 'image/jpeg', size: 5 }, '612');
    const id3 = st1._registerMedia({ kind: 'image', path: tmpImg3, fileName: 'c.jpg', mime: 'image/jpeg', size: 5 }, '612');
    fs.unlinkSync(tmpImg2);                    // id2 文件删除（模拟磁盘 GC）
    st1._mediaStore.get(id3).ts = Date.now() - 25 * 3600 * 1000;   // id3 超 TTL
    st1._saveMediaStore();                     // 手动落盘（含被改的 ts）
    check('A 登记表已落盘', fs.existsSync(storeFile) && fs.statSync(storeFile).size > 10);

    // B. 新实例模拟重启 → 恢复有效条目（id1 恢复；id2 文件缺失、id3 超 TTL 都不恢复）
    const st2 = new StewardManager({ engine: engineStub });
    const r1 = st2.getMedia(id1);
    const r2 = st2.getMedia(id2);
    const r3 = st2.getMedia(id3);
    check('B 重启后旧 mediaId 恢复', r1 !== null && r1.path === tmpImg, r1 ? '恢复 ✓' : 'null');
    check('C 文件被 GC 的条目不恢复', r2 === null, r2 === null ? '跳过 ✓' : '误恢复');
    check('D 超 TTL 的条目不恢复', r3 === null, r3 === null ? '跳过 ✓' : '误恢复');

    const pass = results.filter(Boolean).length;
    console.log(`\n${pass}/${results.length} 通过`);
    process.exit(pass === results.length ? 0 : 1);
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  } finally {
    // 清理临时文件与登记表
    for (const f of [tmpImg, tmpImg2, tmpImg3]) { try { fs.unlinkSync(f); } catch {} }
    try {
      if (backup !== null) fs.writeFileSync(storeFile, backup);
      else fs.rmSync(storeFile, { force: true });
    } catch {}
  }
})();
