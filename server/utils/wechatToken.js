/**
 * 微信 access_token 管理
 * - 带本地缓存（data/token.json），2小时过期自动刷新
 * - 个人未认证订阅号 draft/add 权限，以实际调用为准，这里只管取token
 */
const axios = require('axios');
const { readJson, writeJson, DATA_DIR, sleep } = require('./helpers');
const path = require('path');

const TOKEN_FILE = path.join(DATA_DIR, 'token.json');
const EXPIRE_SAFETY = 180; // 提前180秒判过期

let memoryToken = null;

function getConfig() {
  const appid = process.env.WECHAT_APPID;
  const secret = process.env.WECHAT_APPSECRET;
  return { appid, secret, ready: !!appid && !!secret && !secret.includes('请替换') };
}

/** 从缓存或微信取 access_token */
async function getAccessToken({ forceRefresh = false } = {}) {
  const { appid, secret, ready } = getConfig();
  if (!ready) {
    throw new Error('凭证未配置：请在.env里填写 WECHAT_APPID 和 WECHAT_APPSECRET');
  }

  if (!forceRefresh && memoryToken && memoryToken.expiresAt > Date.now()) {
    return memoryToken.token;
  }

  if (!forceRefresh) {
    const cached = readJson(TOKEN_FILE, null);
    if (cached && cached.expiresAt > Date.now() && cached.token) {
      memoryToken = cached;
      return cached.token;
    }
  }

  // 走网络
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  if (!data.access_token) {
    const msg = data.errmsg || '获取 access_token 失败';
    const code = data.errcode;
    // 40164 IP白名单
    if (code === 40164) {
      throw new Error(`微信IP白名单未配置：${msg}。去公众平台后台「基本配置」把您家出口IP加进白名单再试。`);
    }
    throw new Error(`取token失败：[${code}] ${msg}`);
  }

  const record = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - EXPIRE_SAFETY) * 1000,
    fetchedAt: Date.now(),
  };
  memoryToken = record;
  writeJson(TOKEN_FILE, record);
  return record.token;
}

/** 清缓存（用于调试） */
function resetToken() {
  memoryToken = null;
  try { require('fs').unlinkSync(TOKEN_FILE); } catch (_) {}
}

module.exports = {
  getAccessToken,
  resetToken,
  getConfig,
};
