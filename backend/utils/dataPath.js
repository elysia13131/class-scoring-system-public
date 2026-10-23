/**
 * 数据目录路径工具
 * 生产环境（Docker）持久化卷挂载在 /backend/data
 * 本地开发使用相对路径
 */

const path = require('path');
const fs = require('fs');

const PROD_DATA_DIR = '/backend/data';

function getDataDir() {
  if (fs.existsSync(PROD_DATA_DIR)) return PROD_DATA_DIR;
  return path.join(__dirname, '..', 'data');
}

function getDataPath(...segments) {
  return path.join(getDataDir(), ...segments);
}

module.exports = { getDataDir, getDataPath };