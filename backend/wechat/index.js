const { AgentLinkWechat } = require('@agentlink/wechat');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { hasAnsweredToday } = require('../agent/pushScheduler');
const axios = require('axios');
const { renderChartToImage } = require('../agent/chartImageRenderer');
const { getDataPath } = require('../utils/dataPath');

const REGISTRY_FILE = getDataPath('wechat', 'bot_registry.json');

class WeChatBotManager {
  constructor({ engine }) {
    if (!engine) throw new Error('engine is required');
    this.engine = engine;
    this.bots = new Map();
    this.dataDir = getDataPath('wechat', 'bots');
    this._ensureDirs();
    this._restoreBots();
  }

  _ensureDirs() {
    for (const d of [this.dataDir, path.dirname(REGISTRY_FILE)]) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
  }

  _loadRegistry() {
    try {
      if (fs.existsSync(REGISTRY_FILE)) return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    } catch (e) {}
    return [];
  }

  _saveRegistry() {
    try {
      const data = Array.from(this.bots.values()).map(e => ({ memberId: e.memberId, isAdmin: e.isAdmin }));
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {}
  }

  _restoreBots() {
    const registry = this._loadRegistry();
    for (const { memberId, isAdmin } of registry) {
      this._createBot(memberId, isAdmin, true);
    }
    if (registry.length > 0) {
      console.log(`[WeChat] 已恢复 ${registry.length} 个Bot`);
    }
  }

  _createBot(memberId, isAdmin, restoring = false) {
    const botDir = path.join(this.dataDir, memberId);
    if (!fs.existsSync(botDir)) fs.mkdirSync(botDir, { recursive: true });

    const bot = new AgentLinkWechat({ dataDir: botDir, dmPolicy: 'open' });
    const entry = {
      memberId, isAdmin, bot,
      loggedIn: false,
      qrcodeUrl: null,
      qrcodeTimestamp: null,
      ownerUserId: null,
      stopped: false,
      _qrTimeout: null,
    };

    bot.on('qrcode', (url) => {
      entry.qrcodeUrl = url;
      entry.qrcodeTimestamp = Date.now();
    });

    bot.on('login', () => {
      entry.loggedIn = true;
      this._saveRegistry();
      console.log(`[WeChat] Bot ${entry.memberId} 已上线`);
    });

    bot.on('logout', () => {
      entry.loggedIn = false;
      console.log(`[WeChat] Bot ${entry.memberId} 已断开`);
    });

    bot.on('message', (message) => {
      const userId = message.userId;
      if (userId && !entry.ownerUserId) entry.ownerUserId = userId;
      this._onMessage(entry, message);
    });

    bot.on('error', (error) => {
      if (!error.isTimeout) console.error(`[WeChat] Bot ${entry.memberId} 错误:`, error.message);
    });

    this.bots.set(memberId, entry);

    if (!restoring) {
      this._runBotLoop(entry);
    }

    return entry;
  }

  _runBotLoop(entry) {
    const QR_REFRESH_MS = 60 * 1000;
    const MAX_QR_WAIT_MS = 3 * 60 * 1000;

    const loop = async () => {
      const qrStartTime = Date.now();
      while (!entry.stopped) {
        try {
        entry.qrcodeUrl = null;
        entry.qrcodeTimestamp = null;
        entry.loggedIn = false;
        entry._qrWaitSince = entry._qrWaitSince || Date.now();

        await entry.bot.login();
        if (entry.stopped) break;

        await Promise.race([
          entry.bot.waitForLogin(),
          new Promise((_, reject) => {
            entry._qrTimeout = setTimeout(() => reject(new Error('QR_TIMEOUT')), QR_REFRESH_MS);
          }),
        ]);
        clearTimeout(entry._qrTimeout);
        if (entry.stopped) break;

        await entry.bot.start();
        entry.loggedIn = true;
        entry._qrWaitSince = null;

        await new Promise(resolve => {
            const handler = () => {
              entry.bot.removeListener('logout', handler);
              resolve();
            };
            entry.bot.on('logout', handler);
          });

          entry.loggedIn = false;
          await new Promise(r => setTimeout(r, 3000));
        } catch (err) {
          clearTimeout(entry._qrTimeout);
          if (entry.stopped) break;
          if (err.message === 'QR_TIMEOUT') {
            const waited = Date.now() - (entry._qrWaitSince || Date.now());
            if (waited >= MAX_QR_WAIT_MS) {
              console.log(`[WeChat] Bot ${entry.memberId} 超时未扫码（已等待${Math.round(waited / 1000)}秒），自动停止`);
              entry.stopped = true;
              try { await entry.bot.stop(); } catch {}
              this.bots.delete(entry.memberId);
              this._saveRegistry();
              break;
            }
            console.log(`[WeChat] Bot ${entry.memberId} 二维码刷新（60秒超时，已等待${Math.round(waited / 1000)}秒）`);
            try { await entry.bot.stop(); } catch {}
            continue;
          }
          await new Promise(r => setTimeout(r, 5000));
        }
      }
      entry.loggedIn = false;
    };
    loop().catch(err => {
      console.error(`[WeChat] Bot ${entry.memberId} 循环异常:`, err.message);
    });
  }

  async _waitForQrcode(entry, timeout = 15000) {
    if (entry.qrcodeUrl) return;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, 200));
      if (entry.qrcodeUrl) return;
    }
  }

  async createMemberBot(memberId, password) {
    const members = this._getMembers();
    const member = members.find(m => m.id === memberId);
    if (!member) throw new Error('成员未找到');
    if (!member.password) throw new Error('PASSWORD_NOT_SET');
    if (!bcrypt.compareSync(password, member.password)) throw new Error('密码错误');

    const existing = this.bots.get(memberId);
    if (existing && existing.qrcodeUrl && !existing.loggedIn) return { qrcodeUrl: existing.qrcodeUrl, memberId };
    if (existing && existing.loggedIn) return { qrcodeUrl: null, memberId, loggedIn: true };

    this._createBot(memberId, false);
    await this._waitForQrcode(this.bots.get(memberId));
    const bot = this.bots.get(memberId);
    return { qrcodeUrl: bot.qrcodeUrl, memberId, loggedIn: bot.loggedIn };
  }

  async createAdminBot(password) {
    const result = await this.engine.verifyAdmin('wechat_admin_main', password);
    if (!result || !result.success) throw new Error('管理员密码错误');

    const memberId = 'admin_' + crypto.randomBytes(4).toString('hex');
    const existing = this.bots.get(memberId);
    if (existing && existing.qrcodeUrl && !existing.loggedIn) return { qrcodeUrl: existing.qrcodeUrl, memberId };
    if (existing && existing.loggedIn) return { qrcodeUrl: null, memberId, loggedIn: true };

    this._createBot(memberId, true);
    await this._waitForQrcode(this.bots.get(memberId));
    const bot = this.bots.get(memberId);
    return { qrcodeUrl: bot.qrcodeUrl, memberId, loggedIn: bot.loggedIn };
  }

  async _onMessage(entry, message) {
    const { memberId, isAdmin, bot } = entry;

    // 管理员回答每日一问：如果今天还没回答过，微信消息直接作为每日一问的答案
    if (isAdmin && !hasAnsweredToday(memberId)) {
      const text = (message.text || '').trim();
      if (text) {
        try {
          const PORT = process.env.PORT || 3001;
          const replyRes = await axios.post(`http://127.0.0.1:${PORT}/api/checkin/feedback`, {
            memberId, type: 'question', text, isAdmin: true
          });
          const feedback = replyRes.data?.feedback || '';
          const response = feedback || '收到你的回答，明天见！';
          await message.reply(`📋 ${response}`);
          return;
        } catch (e) {
          console.error(`[WeChat] 管理员答题失败 ${memberId}:`, e.message);
          try { await message.reply('收到你的回答，但处理时出了点问题，稍后再试吧'); } catch {}
          return;
        }
      }
    }

    // 如果上轮对话仍在迭代中，将新消息注入当前迭代
    if (this.engine.isProcessing(memberId)) {
      this.engine.injectUserMessage(memberId, (message.text || '').trim());
      await message.reply('⏳ 正在处理上轮对话，你的新消息已加入队列...').catch(() => {});
      return;
    }

    bot.typing.start(message.userId, message.contextToken).catch(() => {});

    try {
      let buffer = '';
      let roundCount = 0;

      const sendRound = (text) => {
        if (!text) return;
        roundCount++;
        message.reply((roundCount > 0 ? '\n' : '') + text).catch(() => {});
      };

      const chartConfigs = [];

      const result = await this.engine.processMessageStreamWithCallback(
        memberId, (message.text || '').trim(), null, { isAdmin },
        {
          onToken: (token) => { buffer += token; },
          onToolCall: () => { sendRound(buffer); buffer = ''; },
          onToolResult: () => {},
          onChart: (data) => {
            if (data?.config) chartConfigs.push(data.config);
          },
          onForm: () => {},
          onError: () => { sendRound(buffer || '抱歉，处理时出现错误。'); buffer = ''; },
          onDone: () => { sendRound(buffer); buffer = ''; },
        }
      );

      // 发送所有图表为图片
      if (chartConfigs.length > 0) {
        await message.reply('📊 图表发送中...').catch(() => {});
      }
      for (const config of chartConfigs) {
        try {
          const imagePath = await renderChartToImage(config, 600, 400);
          if (imagePath) {
            await entry.bot.sendImage(message.userId, imagePath);
            console.log(`[WeChat] 图表图片已发送 → ${memberId}`);
          } else {
            await message.reply('图表生成失败，请稍后重试').catch(() => {});
          }
        } catch (e) {
          console.error(`[WeChat] 图表图片发送失败:`, e.message);
          await message.reply('图表发送失败，可尝试用浏览器打开系统查看').catch(() => {});
        }
      }

      bot.typing.stop(message.userId).catch(() => {});
    } catch (err) {
      console.error(`[WeChat] Bot ${memberId} 消息处理失败:`, err.message);
      try { await message.reply('抱歉，处理消息时出现错误。'); } catch {}
      bot.typing.stop(message.userId).catch(() => {});
    }
  }

  async sendToMember(memberId, text) {
    const entry = this.bots.get(memberId);
    if (!entry) return { success: false, error: `成员 ${memberId} 未创建Bot` };
    if (!entry.loggedIn) return { success: false, error: `成员 ${memberId} 的Bot未在线` };
    if (!entry.ownerUserId) return { success: false, error: `成员 ${memberId} 的Bot还未收到消息` };

    try {
      await entry.bot.sendText(entry.ownerUserId, text);
      console.log(`[WeChat] 推送 → ${memberId}: ${text.substring(0, 50)}`);
      return { success: true };
    } catch (err) {
      return { success: false, error: `发送失败: ${err.message}` };
    }
  }

  async sendToMemberImage(memberId, imagePath) {
    const entry = this.bots.get(memberId);
    if (!entry) return { success: false, error: `成员 ${memberId} 未创建Bot` };
    if (!entry.loggedIn) return { success: false, error: `成员 ${memberId} 的Bot未在线` };
    if (!entry.ownerUserId) return { success: false, error: `成员 ${memberId} 的Bot还未收到消息` };

    try {
      await entry.bot.sendImage(entry.ownerUserId, imagePath);
      console.log(`[WeChat] 图片推送 → ${memberId}: ${imagePath}`);
      return { success: true };
    } catch (err) {
      return { success: false, error: `图片发送失败: ${err.message}` };
    }
  }

  _getMembers() {
    try {
      const f = getDataPath('members.json');
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
    } catch (e) {}
    return [];
  }

  getStatus() {
    const bots = Array.from(this.bots.values()).map(e => ({
      memberId: e.memberId, isAdmin: e.isAdmin, loggedIn: e.loggedIn
    }));
    return { enabled: true, total: bots.length, online: bots.filter(b => b.loggedIn).length, bots };
  }

  getBotStatus(memberId) {
    const entry = this.bots.get(memberId);
    if (!entry) return null;
    return {
      memberId: entry.memberId,
      isAdmin: entry.isAdmin,
      loggedIn: entry.loggedIn,
      qrcodeUrl: entry.qrcodeUrl,
      qrcodeTimestamp: entry.qrcodeTimestamp,
      ownerBound: !!entry.ownerUserId,
    };
  }

  isBotOnline(memberId) {
    const entry = this.bots.get(memberId);
    return entry && entry.loggedIn;
  }

  async stopBot(memberId) {
    const entry = this.bots.get(memberId);
    if (!entry) return;
    entry.stopped = true;
    try { await entry.bot.stop(); } catch {}
    this.bots.delete(memberId);
    this._saveRegistry();
  }

  async stopAll() {
    for (const [, entry] of this.bots) {
      entry.stopped = true;
      try { await entry.bot.stop(); } catch {}
    }
    this.bots.clear();
    this._saveRegistry();
  }

  getBackupData() {
    const registry = Array.from(this.bots.values()).map(e => ({
      memberId: e.memberId,
      isAdmin: e.isAdmin,
    }));
    return { registry, dataDir: this.dataDir };
  }

  async reloadFromBackup() {
    for (const [, entry] of this.bots) {
      entry.stopped = true;
      try { await entry.bot.stop(); } catch {}
    }
    this.bots.clear();
    this._restoreBots();
    return this.bots.size;
  }
}

module.exports = WeChatBotManager;