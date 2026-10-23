/**
 * antirepeat —— 模型输出防复读（Phase6，输出侧）
 *
 * 收敛范围：仅处理"模型对同一会话连续输出相同文本"的复读机现象。
 * 行级检测（流式回复按行发送，逐行查重）：
 *  - 行规范化（去首尾空白/标点/语气词尾巴）后与前一条重复 → dup，丢弃不入队；
 *  - 同一文本连续出现第 3 次 → 触发一次转向（tripped）：本行丢弃，调用方
 *    发送固定转向话术 + 向会话注入打破事件，让模型下一轮自主脱离复读；
 *  - 任一非重复行出现 → 计数清零；
 *  - 转向后 60s 冷却：期间再遇相同文本只静默丢弃（dup），不反复转向刷屏。
 * 键 = 会话在引擎侧的 member 标识（私聊 memberId / 群 group-xxx）。
 */

const TRIP_AFTER = 3;          // 同一文本连续出现第 N 次时转向（首次正常发出，第 2 次起拦截）
const TRIP_COOLDOWN_MS = 60 * 1000;

/** 规范化：trim + 去尾部标点/波浪/省略号/语气叠词（句末「呀啦哦嘛～.。!！?？~… 」类） */
function normalizeLine(text) {
  let s = String(text || '').trim();
  s = s.replace(/[\s]+/g, ' ').trim();
  s = s.replace(/[。．.!！?？～~，,；;…]+$/g, '').trim();
  return s;
}

class AntiRepeat {
  constructor() {
    this._rec = new Map();   // key → { text, count, lastTrip }
  }

  /**
   * @param {string} key 会话 key
   * @param {string} line 待发文本行
   * @returns {'ok'|'dup'|'tripped'} ok=可发；dup=与上一条重复已丢弃；
   *   tripped=连续重复达阈值，调用方应转向（本行丢弃）
   */
  check(key, line) {
    const text = normalizeLine(line);
    if (!text) return 'ok';
    const now = Date.now();
    const rec = this._rec.get(key);
    if (rec && rec.text === text) {
      rec.count += 1;
      if (rec.count >= TRIP_AFTER) {
        if (rec.lastTrip && now - rec.lastTrip < TRIP_COOLDOWN_MS) {
          rec.count = TRIP_AFTER - 1;   // 冷却内：保持"下一次到阈值即转向"，本次静默丢
          return 'dup';
        }
        rec.lastTrip = now;
        rec.count = 0;                  // 转向后归零：若模型再次复读，当作新一段重计
        return 'tripped';
      }
      return 'dup';
    }
    this._rec.set(key, { text, count: 1, lastTrip: rec ? rec.lastTrip : 0 });
    return 'ok';
  }

  reset(key) {
    this._rec.delete(key);
  }
}

module.exports = { AntiRepeat, TRIP_AFTER, TRIP_COOLDOWN_MS, normalizeLine };
