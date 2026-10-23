const webpush = require('web-push');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { getDataDir } = require('../utils/dataPath');

const DATA_DIR = getDataDir();
const VAPID_KEYS_FILE = path.join(DATA_DIR, 'vapid_keys.json');
const PUSH_SUBS_FILE = path.join(DATA_DIR, 'push_subscriptions.json');
const JPUSH_TOKENS_FILE = path.join(DATA_DIR, 'jpush_tokens.json');
const JPUSH_CONFIG_FILE = path.join(DATA_DIR, 'jpush_config.json');
const NOTIFICATION_INBOX_FILE = path.join(DATA_DIR, 'notification_inbox.json');

const EMAIL = 'mailto:admin@class-system.local';

let jpushReady = false;
let jpushConfig = null;

function getWebPushKeys() {
  if (fs.existsSync(VAPID_KEYS_FILE)) {
    const keys = JSON.parse(fs.readFileSync(VAPID_KEYS_FILE, 'utf-8'));
    if (keys.publicKey && keys.privateKey) return keys;
  }
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_KEYS_FILE, JSON.stringify(keys, null, 2));
  webpush.setVapidDetails(EMAIL, keys.publicKey, keys.privateKey);
  return keys;
}

function getVapidPublicKey() {
  return getWebPushKeys().publicKey;
}

function initJPush() {
  if (jpushReady) return true;
  if (!fs.existsSync(JPUSH_CONFIG_FILE)) {
    console.log('[Push] JPush config not found. Place jpush_config.json in data/ with { "appKey":"...", "masterSecret":"..." }');
    return false;
  }
  try {
    jpushConfig = JSON.parse(fs.readFileSync(JPUSH_CONFIG_FILE, 'utf-8'));
    if (jpushConfig.appKey && jpushConfig.masterSecret) {
      jpushReady = true;
      console.log('[Push] JPush initialized, appKey:', jpushConfig.appKey.substring(0, 8) + '...');
      return true;
    }
    console.error('[Push] JPush config missing appKey or masterSecret');
    return false;
  } catch (err) {
    console.error('[Push] JPush config parse error:', err.message);
    return false;
  }
}

function initWebPush() {
  const keys = getWebPushKeys();
  webpush.setVapidDetails(EMAIL, keys.publicKey, keys.privateKey);
  console.log(`[Push] Web Push ready, public: ${keys.publicKey.substring(0, 16)}...`);
}

function initPushManager() {
  initWebPush();
  initJPush();
}

function readJSON(file) {
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return []; }
}
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// --- JPush Tokens ---
function saveJPushToken(memberId, registrationId, platform = 'android') {
  const tokens = readJSON(JPUSH_TOKENS_FILE);
  const existingIdx = tokens.findIndex(t => t.memberId === memberId);
  if (existingIdx >= 0) {
    tokens[existingIdx] = { memberId, registrationId, platform, updatedAt: new Date().toISOString() };
  } else {
    tokens.push({ memberId, registrationId, platform, createdAt: new Date().toISOString() });
  }
  writeJSON(JPUSH_TOKENS_FILE, tokens);
  console.log(`[Push] JPush regId saved for ${memberId}: ${registrationId.substring(0, 12)}...`);
}

function removeJPushToken(memberId) {
  writeJSON(JPUSH_TOKENS_FILE, readJSON(JPUSH_TOKENS_FILE).filter(t => t.memberId !== memberId));
}

function hasJPushToken(memberId) {
  return jpushReady && readJSON(JPUSH_TOKENS_FILE).some(t => t.memberId === memberId);
}

// --- Web Push Subscriptions ---
function saveWebPushSub(memberId, subscription) {
  const subs = readJSON(PUSH_SUBS_FILE);
  const existingIdx = subs.findIndex(s => s.memberId === memberId);
  if (existingIdx >= 0) {
    subs[existingIdx] = { memberId, subscription, updatedAt: new Date().toISOString() };
  } else {
    subs.push({ memberId, subscription, createdAt: new Date().toISOString() });
  }
  writeJSON(PUSH_SUBS_FILE, subs);
}

function removeWebPushSub(memberId) {
  writeJSON(PUSH_SUBS_FILE, readJSON(PUSH_SUBS_FILE).filter(s => s.memberId !== memberId));
}

function hasWebPushSub(memberId) {
  return readJSON(PUSH_SUBS_FILE).some(s => s.memberId === memberId);
}

// --- JPush Send via HTTP API ---
function sendJPushRequest(payload) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${jpushConfig.appKey}:${jpushConfig.masterSecret}`).toString('base64');
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.jpush.cn',
      path: '/v3/push',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (res.statusCode === 200) resolve(result);
          else reject(new Error(result.error?.message || `HTTP ${res.statusCode}`));
        } catch (e) {
          reject(new Error(body));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendJPush(memberId, title, body, extras) {
  if (!jpushReady) return { success: false, error: 'JPush未初始化' };
  const tokens = readJSON(JPUSH_TOKENS_FILE).filter(t => t.memberId === memberId);
  if (tokens.length === 0) return { success: false, error: '无JPush注册ID', noToken: true };

  const regIds = tokens.map(t => t.registrationId);
  try {
    const androidNotif = {
      alert: body,
      title: title,
      priority: 1
    };
    if (extras) {
      androidNotif.extras = typeof extras === 'string' ? JSON.parse(extras) : extras;
    }
    const result = await sendJPushRequest({
      platform: 'android',
      audience: { registration_id: regIds },
      notification: {
        android: androidNotif
      },
      options: {
        apns_production: false,
        time_to_live: 86400
      }
    });
    console.log(`[Push] JPush sent to ${memberId}: "${title}" msgId:${result.msg_id}`);
    return { success: true, msgId: result.msg_id, sentCount: regIds.length };
  } catch (err) {
    console.error(`[Push] JPush send error:`, err.message);
    return { success: false, error: err.message, noToken: false };
  }
}

// JPush 发送（带 extras，用于路由跳转）
async function sendJPushWithExtras(memberId, title, body, extras) {
  if (!jpushReady) return { success: false, error: 'JPush未初始化' };
  const tokens = readJSON(JPUSH_TOKENS_FILE).filter(t => t.memberId === memberId);
  if (tokens.length === 0) return { success: false, error: '无JPush注册ID', noToken: true };

  const regIds = tokens.map(t => t.registrationId);
  try {
    const result = await sendJPushRequest({
      platform: 'android',
      audience: { registration_id: regIds },
      notification: {
        android: {
          alert: body,
          title: title,
          priority: 1,
          extras: typeof extras === 'string' ? JSON.parse(extras) : (extras || {})
        }
      },
      options: {
        apns_production: false,
        time_to_live: 86400
      }
    });
    console.log(`[Push] JPush+Extras sent to ${memberId}: "${title}" msgId:${result.msg_id}`);
    return { success: true, msgId: result.msg_id, sentCount: regIds.length };
  } catch (err) {
    console.error(`[Push] JPush+Extras send error:`, err.message);
    return { success: false, error: err.message, noToken: false };
  }
}

async function sendWebPush(memberId, title, body) {
  const subs = readJSON(PUSH_SUBS_FILE).filter(s => s.memberId === memberId);
  if (subs.length === 0) return { success: false, error: '无Web推送订阅', noSubscription: true };

  let successCount = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub.subscription, JSON.stringify({ title, body, memberId }));
      successCount++;
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) removeWebPushSub(memberId);
    }
  }

  if (successCount > 0) {
    console.log(`[Push] Web Push sent to ${memberId}: "${title}"`);
    return { success: true, sentCount: successCount };
  }
  return { success: false, error: 'Web Push发送失败', noSubscription: false };
}

// --- Notification Inbox (HTTP 长轮询兜底通道) ---
// 移动端 APP 前台时定时拉取自己的通知，收到后用 LocalNotifications 弹出
// 清理策略：保留最近 3 天 + 最多 500 条（双重限制）
const INBOX_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;  // 3 天
const INBOX_MAX_COUNT = 500;

function cleanupInbox(inbox) {
  const now = Date.now();
  // 先按时间过滤：保留最近 3 天
  let filtered = inbox.filter(n => {
    if (!n.createdAt) return true;
    const t = new Date(n.createdAt).getTime();
    return (now - t) < INBOX_MAX_AGE_MS;
  });
  // 再按数量限制：保留最近 500 条
  if (filtered.length > INBOX_MAX_COUNT) {
    filtered = filtered.slice(-INBOX_MAX_COUNT);
  }
  return filtered;
}

function saveNotificationToInbox(memberId, title, body, extras) {
  const inbox = readJSON(NOTIFICATION_INBOX_FILE);
  const notifId = `n_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const notif = {
    id: notifId,
    memberId: String(memberId),
    title,
    body,
    extras: extras || null,
    createdAt: new Date().toISOString(),
    read: false
  };
  inbox.push(notif);
  // 双重清理：3 天 + 500 条
  const trimmed = cleanupInbox(inbox);
  writeJSON(NOTIFICATION_INBOX_FILE, trimmed);
  return notifId;
}

function getInboxByMember(memberId, sinceId) {
  const inbox = readJSON(NOTIFICATION_INBOX_FILE);
  const memberNotifs = inbox.filter(n => String(n.memberId) === String(memberId));
  if (sinceId) {
    const idx = memberNotifs.findIndex(n => n.id === sinceId);
    // sinceId 找不到时返回空数组（客户端明确要"该 id 之后的新通知"，找不到说明该 id 不属于此成员）
    // 长轮询场景下，找不到时返回空才会进入 hold 阶段等待新消息
    if (idx >= 0) return memberNotifs.slice(idx + 1);
    return [];
  }
  return memberNotifs;
}

function markInboxRead(memberId, notifIds) {
  const inbox = readJSON(NOTIFICATION_INBOX_FILE);
  const idSet = new Set((notifIds || []).map(String));
  inbox.forEach(n => {
    // memberId 为 null 时仅按 notifIds 标记（用于按通知 ID 标记已读）
    const memberMatch = memberId == null || String(n.memberId) === String(memberId);
    const idMatch = idSet.size === 0 || idSet.has(n.id);
    if (memberMatch && idMatch) {
      n.read = true;
    }
  });
  writeJSON(NOTIFICATION_INBOX_FILE, inbox);
}

// --- Unified send: JPush > Web Push > Inbox ---
async function sendPushToMember(memberId, title, body, extras) {
  const results = [];

  // 0. 始终写入 inbox 作为兜底（确保 APP 在线时能拉到）
  const inboxId = saveNotificationToInbox(memberId, title, body, extras);

  // 1. 优先 JPush（Capacitor 原生 APK）
  try {
    const jpushResult = await sendJPush(memberId, title, body, extras);
    if (jpushResult.success) {
      return { channel: 'jpush', ...jpushResult, inboxId };
    }
    results.push({ channel: 'jpush', error: jpushResult.error });
  } catch (e) {
    results.push({ channel: 'jpush', error: e.message });
  }

  // 2. Web Push（PWA/浏览器）
  try {
    const wpResult = await sendWebPush(memberId, title, body);
    if (wpResult.success) {
      return { channel: 'webpush', ...wpResult, inboxId };
    }
    results.push({ channel: 'webpush', error: wpResult.error });
  } catch (e) {
    results.push({ channel: 'webpush', error: e.message });
  }

  // 3. 兜底：已写入 inbox，APP 长轮询拉取
  return { channel: 'inbox', success: true, inboxId, fallbacks: results };
}

function hasAnyPushSubscription(memberId) {
  return hasJPushToken(memberId) || hasWebPushSub(memberId);
}

function isPushNativeReady() {
  return jpushReady;
}

module.exports = {
  getVapidPublicKey,
  initPushManager,
  initWebPush,
  saveJPushToken,
  removeJPushToken,
  hasJPushToken,
  saveWebPushSub,
  removeWebPushSub,
  hasWebPushSub,
  sendPushToMember,
  sendJPushWithExtras,
  hasAnyPushSubscription,
  isPushNativeReady,
  getInboxByMember,
  markInboxRead,
  saveNotificationToInbox,
  cleanupInbox,
  NOTIFICATION_INBOX_FILE
};
