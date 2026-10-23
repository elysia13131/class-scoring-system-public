const { getDataPath } = require('../../utils/dataPath');
const { getCurrentWeek, getCurrentSemesterId } = require('../../utils/semester');

class BaseTool {
  constructor(config = {}) {
    this.name = config.name;
    this.description = config.description || '';
    this.parameters = config.parameters || {};
    this.requireAuth = config.requireAuth || false;
    this.category = config.category || 'general';
  }

  async execute(params, context) {
    throw new Error(`子类 ${this.name} 必须实现 execute 方法`);
  }

  validateParams(params) {
    const errors = [];
    const requiredParams = Object.entries(this.parameters)
      .filter(([, schema]) => schema.required)
      .map(([name]) => name);

    for (const param of requiredParams) {
      if (!(param in params)) {
        errors.push(`缺少必需参数: ${param}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  getSchema() {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
      requireAuth: this.requireAuth,
      category: this.category
    };
  }

  formatResult(result) {
    const wrapped = {
      success: result?.success !== undefined ? result.success : true,
      tool: this.name,
      data: result,
      timestamp: new Date().toISOString()
    };
    if (result?.type === 'form') {
      wrapped.isForm = true;
    }
    if (result?.config) {
      wrapped.hasChart = true;
    }
    return wrapped;
  }

  formatError(error) {
    return {
      success: false,
      tool: this.name,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }

  _safeJsonParse(str, fallback = null) {
    try { return JSON.parse(str); } catch { return fallback; }
  }

  async _fetchAPI(endpoint, method = 'get', data = null) {
    const axios = require('axios');
    const port = process.env.PORT || 3001;
    const url = `http://127.0.0.1:${port}${endpoint}`;
    const headers = {};
    const apiKey = process.env.__INTERNAL_API_KEY;
    if (apiKey) {
      headers['Authorization'] = 'Bearer ' + apiKey;
    }
    try {
      if (method.toLowerCase() === 'get') {
        return (await axios.get(url, { headers })).data;
      } else {
        return (await axios.post(url, data, { headers })).data;
      }
    } catch (err) {
      console.error(`[BaseTool] API请求失败 ${method} ${url}:`, err.message);
      throw err;
    }
  }

  _getCurrentWeek() {
    return getCurrentWeek();
  }

  _getCurrentSemesterId() {
    return getCurrentSemesterId();
  }

  async _getMembersFromAPI() {
    try {
      const data = await this._fetchAPI('/api/members');
      const list = Array.isArray(data) ? data : (data.members || []);
      return list.map(m => ({
        id: String(m.id || m.memberId || ''),
        name: m.name || m.nickname || '',
        class: m.class || ''
      })).filter(m => m.id);
    } catch (err) {
      return this._getMembersFromFile();
    }
  }

  _getMembersFromFile() {
    try {
      const fs = require('fs').promises;
      const path = require('path');
      const filePath = getDataPath('members.json');
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const list = Array.isArray(raw) ? raw : (raw.members || []);
      return list.map(m => ({
        id: String(m.id || m.memberId || ''),
        name: m.name || m.nickname || '',
        class: m.class || ''
      })).filter(m => m.id);
    } catch (e) {
      return [];
    }
  }
}

module.exports = BaseTool;
