/**
 * 持久化卷数据种子脚本
 * 首次部署时，将镜像中的数据文件复制到持久化卷 /backend/data
 */
const fs = require('fs');
const path = require('path');

const IMAGE_DATA_DIR = path.join(__dirname, 'data');
const VOLUME_DATA_DIR = '/backend/data';

// 不需要复制的文件和目录
const SKIP_ITEMS = new Set([
  '.gitkeep',
  'scheduleStore.js',
  'automationStore.js',
  'checkin_records',    // store.js 是代码，不是数据
  'apk',                // APK 文件太大，按需处理
  'example',            // 示例文件
]);

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_ITEMS.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else if (!fs.existsSync(dstPath)) {
      // 只复制不存在的文件，避免覆盖已有数据
      fs.copyFileSync(srcPath, dstPath);
      console.log(`  [seed] ${entry.name}`);
    }
  }
}

function seed() {
  // 检查持久化卷是否已挂载
  if (!fs.existsSync(VOLUME_DATA_DIR)) {
    console.log('[seed] 持久化卷 /backend/data 不存在，跳过数据种子');
    return;
  }

  // 检查是否需要种子（目录为空或有 seed.lock 文件跳过）
  const lockFile = path.join(VOLUME_DATA_DIR, '.seed.lock');
  if (fs.existsSync(lockFile)) {
    console.log('[seed] 数据已种子过，跳过');
    return;
  }

  console.log('[seed] 开始种子数据到持久化卷...');
  try {
    copyDir(IMAGE_DATA_DIR, VOLUME_DATA_DIR);
    // 写入锁文件，避免重复种子
    fs.writeFileSync(lockFile, new Date().toISOString());
    console.log('[seed] 数据种子完成');
  } catch (err) {
    console.error('[seed] 数据种子失败:', err.message);
  }
}

seed();