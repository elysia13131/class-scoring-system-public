const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(__dirname);

function getMemberFile(memberId) {
  return path.join(DATA_DIR, `${memberId}.json`);
}

function readRecords(memberId) {
  const file = getMemberFile(memberId);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return [];
  }
}

function writeRecord(memberId, record) {
  const file = getMemberFile(memberId);
  const records = readRecords(memberId);
  records.push(record);
  fs.writeFileSync(file, JSON.stringify(records, null, 2), 'utf-8');
  return record;
}

function getRecentRecords(memberId, weeks = 4) {
  const records = readRecords(memberId);
  const cutoff = Date.now() - weeks * 7 * 24 * 60 * 60 * 1000;
  return records.filter(r => new Date(r.timestamp).getTime() > cutoff);
}

function getRecentMoods(memberId, days = 7) {
  const records = readRecords(memberId);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return records
    .filter(r => new Date(r.timestamp).getTime() > cutoff && r.mood)
    .map(r => ({ mood: r.mood, timestamp: r.timestamp }));
}

function getMemberStats(memberId) {
  const records = readRecords(memberId);
  return {
    totalCheckins: records.filter(r => r.type === 'checkin').length,
    totalQuestions: records.filter(r => r.type === 'question').length,
    totalVoiceNotes: records.filter(r => r.type === 'voice').length,
    totalWeeknotes: records.filter(r => r.type === 'weeknote').length,
    lastActivity: records.length > 0 ? records[records.length - 1].timestamp : null,
  };
}

module.exports = { readRecords, writeRecord, getRecentRecords, getRecentMoods, getMemberStats };
