/**
 * 统一工具函数
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

/** 读本地JSON文件 */
function readJson(filePath, defaultValue) {
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return defaultValue;
  }
}

/** 写本地JSON文件，递归建目录 */
function writeJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/** 读目录下所有JSON（带遍历） */
function listJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dirPath, f));
}

/** 生成简单ID（时间戳+6位随机） */
function genId(prefix = 'id') {
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rnd}`;
}

/** 安全返回，封装所有API响应 */
function ok(res, data = {}, msg = 'ok') {
  res.json({ code: 0, msg, data });
}

function fail(res, msg = '操作失败', code = 1, extra = {}) {
  res.json({ code, msg, ...extra });
}

/** 睡眠 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 简单文本哈希（判断风格语料是否已导入） */
function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h << 5) - h + str.charCodeAt(i);
  return Math.abs(h).toString(36);
}

module.exports = {
  DATA_DIR,
  readJson,
  writeJson,
  listJsonFiles,
  genId,
  ok,
  fail,
  sleep,
  hashString,
};
