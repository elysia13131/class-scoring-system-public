const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const { getDataPath } = require('../../utils/dataPath');

const DEFAULT_PROFILE = {
  memberId: '',
  communicationStyle: {
    formality: 0.5,
    responseLength: 'medium',
    humorLevel: 0.3,
    technicalDepth: 0.5,
    emojiUsage: true
  },
  preferences: {
    favoriteFeatures: [],
    quickActions: [],
    language: 'zh-CN',
    chartPreferences: {
      defaultChartType: 'radar',
      colorTheme: 'purple',
      showDataLabels: true
    }
  },
  adaptationHistory: [],
  privacySettings: {
    allowDataCollection: true,
    shareAnonymizedInsights: false,
    retainHistoryDuration: 90
  },
  usageStats: {
    featureUsage: {},
    totalInteractions: 0,
    avgResponseTime: 0
  },
  metadata: {
    matchScore: 0,
    profileMaturity: 0,
    lastAdaptedAt: null,
    createdAt: null
  }
};

class UserProfile {
  constructor(options = {}) {
    this.dataDir = options.dataDir || getDataPath('agent_profiles');
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

    const newProfile = JSON.parse(JSON.stringify(DEFAULT_PROFILE));
    newProfile.memberId = memberId;
    newProfile.metadata.createdAt = new Date().toISOString();

    await this.save(memberId, newProfile);
    return newProfile;
  }

  async get(memberId) {
    try {
      const filePath = this._getFilePath(memberId);
      const compressed = await fs.readFile(filePath);
      const buffer = await _p(zlib.unzip)(compressed);
      return JSON.parse(buffer.toString());
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async save(memberId, profile) {
    profile.metadata.lastAdaptedAt = new Date().toISOString();
    
    const filePath = this._getFilePath(memberId);
    const jsonStr = JSON.stringify(profile, null, 2);
    const compressed = await _p(zlib.deflate)(jsonStr);
    
    await fs.writeFile(filePath, compressed);
  }

  async updateStyle(memberId, styleUpdates) {
    const profile = await this.getOrCreate(memberId);
    const previousValues = { ...profile.communicationStyle };
    
    profile.communicationStyle = {
      ...profile.communicationStyle,
      ...styleUpdates
    };

    this._recordAdaptation(profile, 'communicationStyle', styleUpdates, previousValues);
    await this.save(memberId, profile);
    return profile.communicationStyle;
  }

  async updatePreferences(memberId, prefUpdates) {
    const profile = await this.getOrCreate(memberId);
    profile.preferences = { ...profile.preferences, ...prefUpdates };
    await this.save(memberId, profile);
    return profile.preferences;
  }

  async recordFeatureUsage(memberId, featureName) {
    const profile = await this.getOrCreate(memberId);
    
    profile.usageStats.featureUsage[featureName] = 
      (profile.usageStats.featureUsage[featureName] || 0) + 1;
    profile.usageStats.totalInteractions++;

    if (!profile.preferences.favoriteFeatures.includes(featureName)) {
      if (profile.preferences.favoriteFeatures.length < 6) {
        profile.preferences.favoriteFeatures.push(featureName);
      }
    }

    this._updateMatchScore(profile);
    await this.save(memberId, profile);
  }

  async adaptFromInteraction(memberId, interactionData) {
    const profile = await this.getOrCreate(memberId);
    
    const styleUpdates = {};
    
    if (interactionData.messageLength) {
      const avgLength = interactionData.messageLength;
      if (avgLength < 20 && profile.communicationStyle.responseLength !== 'short') {
        styleUpdates.responseLength = 'short';
      } else if (avgLength > 100 && profile.communicationStyle.responseLength !== 'detailed') {
        styleUpdates.responseLength = 'detailed';
      }
    }

    if (interactionData.usesTechnicalTerms) {
      styleUpdates.technicalDepth = Math.min(1, profile.communicationStyle.technicalDepth + 0.05);
    }

    if (interactionData.formalLanguageDetected) {
      styleUpdates.formality = Math.min(1, profile.communicationStyle.formality + 0.05);
    }

    if (Object.keys(styleUpdates).length > 0) {
      const previousValues = { ...profile.communicationStyle };
      profile.communicationStyle = {
        ...profile.communicationStyle,
        ...styleUpdates
      };
      this._recordAdaptation(profile, 'communicationStyle', styleUpdates, previousValues);
    }

    this._updateMaturity(profile);
    this._updateMatchScore(profile);
    profile.usageStats.totalInteractions++;
    await this.save(memberId, profile);
  }

  getMatchScore(profile) {
    return profile.metadata.matchScore || 0;
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
    return path.join(this.dataDir, `profile_${memberId}.json.gz`);
  }

  _recordAdaptation(profile, category, changes, previousValues) {
    profile.adaptationHistory.push({
      date: new Date().toISOString().split('T')[0],
      change: `调整了${category}`,
      reason: '基于用户交互行为',
      previousValue: previousValues,
      newValue: changes
    });

    if (profile.adaptationHistory.length > 50) {
      profile.adaptationHistory = profile.adaptationHistory.slice(-30);
    }
  }

  _updateMatchScore(profile) {
    const interactions = profile.usageStats.totalInteractions;
    const featuresUsed = Object.keys(profile.usageStats.featureUsage).length;
    
    let score = 0;
    score += Math.min(interactions / 50, 0.4);
    score += Math.min(featuresUsed / 6, 0.3);
    score += (profile.adaptationHistory.length / 20) * 0.3;
    
    profile.metadata.matchScore = Math.min(1, parseFloat(score.toFixed(2)));
  }

  _updateMaturity(profile) {
    const adaptations = profile.adaptationHistory.length;
    profile.metadata.profileMaturity = Math.min(1, adaptations / 15);
  }
}

function _p(fn) {
  return (...args) => new Promise((resolve, reject) => {
    fn(...args, (err, result) => err ? reject(err) : resolve(result));
  });
}

module.exports = UserProfile;