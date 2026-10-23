const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const { getDataPath } = require('../../utils/dataPath');

class LongTermMemory {
  constructor(options = {}) {
    this.dataDir = options.dataDir || getDataPath('agent_memories');
    this.maxSummaries = options.maxSummaries || 50;
    this.maxFacts = options.maxFacts || 200;
    this.retentionDays = options.retentionDays || 90;
  }

  async init() {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  async getOrCreate(memberId) {
    const existing = await this.get(memberId);
    if (existing) return existing;

    const newMemory = {
      memberId,
      summaries: [],
      importantFacts: [],
      learningProgress: {},
      interactionPatterns: {
        peakUsageHours: Array(24).fill(0),
        averageSessionLength: 0,
        favoriteDays: {}
      },
      metadata: {
        totalInteractions: 0,
        firstInteractionDate: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      }
    };

    await this.save(memberId, newMemory);
    return newMemory;
  }

  async get(memberId) {
    try {
      const filePath = this._getFilePath(memberId);
      const compressed = await fs.readFile(filePath);
      const buffer = await _promisify(zlib.unzip)(compressed);
      return JSON.parse(buffer.toString());
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async save(memberId, memory) {
    memory.metadata.lastUpdated = new Date().toISOString();
    
    const filePath = this._getFilePath(memberId);
    const jsonStr = JSON.stringify(memory, null, 2);
    const compressed = await _promisify(zlib.deflate)(jsonStr);
    
    await fs.writeFile(filePath, compressed);
  }

  async addSummary(memberId, summaryData) {
    const memory = await this.getOrCreate(memberId);
    
    memory.summaries.unshift({
      date: summaryData.date || new Date().toISOString().split('T')[0],
      summary: summaryData.summary,
      keywords: summaryData.keywords || [],
      importanceScore: summaryData.importanceScore || 0.5,
      createdAt: new Date().toISOString()
    });

    if (memory.summaries.length > this.maxSummaries) {
      memory.summaries = memory.summaries.slice(0, this.maxSummaries);
    }

    await this.save(memberId, memory);
    return memory.summaries[0];
  }

  async addFact(memberId, factData) {
    const memory = await this.getOrCreate(memberId);

    memory.importantFacts.push({
      fact: factData.fact,
      category: factData.category || 'general',
      confidence: factData.confidence || 0.5,
      sourceSession: factData.sourceSession,
      createdAt: new Date().toISOString()
    });

    if (memory.importantFacts.length > this.maxFacts) {
      this._pruneLowConfidenceFacts(memory);
    }

    await this.save(memberId, memory);
    return memory.importantFacts[memory.importantFacts.length - 1];
  }

  async updateLearningProgress(memberId, progress) {
    const memory = await this.getOrCreate(memberId);
    memory.learningProgress = { ...memory.learningProgress, ...progress };
    await this.save(memberId, memory);
    return memory.learningProgress;
  }

  async recordInteraction(memberId, hour = null) {
    const memory = await this.getOrCreate(memberId);
    memory.metadata.totalInteractions++;
    
    const h = hour !== null ? hour : new Date().getHours();
    memory.interactionPatterns.peakUsageHours[h]++;
    
    const dayOfWeek = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date().getDay()];
    memory.interactionPatterns.favoriteDays[dayOfWeek] = 
      (memory.interactionPatterns.favoriteDays[dayOfWeek] || 0) + 1;

    await this.save(memberId, memory);
  }

  async searchFacts(memberId, query, limit = 10) {
    const memory = await this.get(memberId);
    if (!memory || !memory.importantFacts) return [];

    const queryLower = query.toLowerCase();
    const scored = memory.importantFacts
      .map(fact => ({
        ...fact,
        score: this._calculateRelevance(fact.fact, queryLower)
      }))
      .filter(f => f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored;
  }

  async getRecentSummaries(memberId, count = 5) {
    const memory = await this.get(memberId);
    if (!memory) return [];
    return memory.summaries.slice(0, count);
  }

  async cleanup() {
    try {
      const files = await fs.readdir(this.dataDir);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

      for (const file of files) {
        if (file.endsWith('.gz')) {
          const filePath = path.join(this.dataDir, file);
          const stat = await fs.stat(filePath);
          
          if (stat.mtime < cutoffDate) {
            await fs.unlink(filePath);
          }
        }
      }
    } catch (err) {
      console.error('Cleanup error:', err.message);
    }
  }

  async delete(memberId) {
    try {
      const filePath = this._getFilePath(memberId);
      await fs.unlink(filePath);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      throw err;
    }
  }

  _getFilePath(memberId) {
    return path.join(this.dataDir, `memory_${memberId}.json.gz`);
  }

  _calculateRelevance(fact, query) {
    const factLower = fact.toLowerCase();
    const words = query.split(/\s+/);
    let matchCount = 0;
    
    for (const word of words) {
      if (factLower.includes(word)) matchCount++;
    }
    
    return matchCount / Math.max(words.length, 1);
  }

  _pruneLowConfidenceFacts(memory) {
    memory.importantFacts.sort((a, b) => b.confidence - a.confidence);
    memory.importantFacts = memory.importantFacts.slice(0, this.maxFacts);
  }
}

function _promisify(fn) {
  return (...args) => new Promise((resolve, reject) => {
    fn(...args, (err, result) => err ? reject(err) : resolve(result));
  });
}

module.exports = LongTermMemory;