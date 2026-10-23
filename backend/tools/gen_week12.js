const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SCORES_DIR = require('../utils/semester').getScoresDir();

// 读取成员和上周数据
const members = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'members.json'), 'utf-8'));
const w11 = JSON.parse(zlib.unzipSync(fs.readFileSync(path.join(SCORES_DIR, 'scores_week_11.json.gz'))).toString());

const nameMap = {};
members.forEach(m => nameMap[m.id] = m.name);

// 班级分组
const classMembers = {};
for (const m of members) {
  if (!classMembers[m.class]) classMembers[m.class] = [];
  classMembers[m.class].push(m);
}
console.log('班级分布:', Object.fromEntries(Object.entries(classMembers).map(([k,v])=>[k, v.length])));

// 子项定义
const DIM_SUB_MAP = {
  study: ['study_prep','study_class','study_review','study_apply','study_result'],
  fitness: ['fitness_base','fitness_attitude','fitness_health','fitness_injury','fitness_improve'],
  literacy: ['literacy_reading','literacy_culture','literacy_discipline','literacy_problem','literacy_empathy'],
  discipline: ['discipline_queue','discipline_duty','discipline_daily','discipline_class','discipline_safety'],
  contribution: ['contribution_work','contribution_environment','contribution_collective','contribution_honor','contribution_help'],
  management: ['management_responsibility','management_ability','management_activity','management_improvement'],
};
const ALL_DIMS = Object.keys(DIM_SUB_MAP);
const ALL_SUB_KEYS = Object.values(DIM_SUB_MAP).flat();

// 子项最大值约束
const SUB_MAX = {
  fitness_base: 3, fitness_improve: 1,
  discipline_daily: 3, discipline_safety: 1,
  management_responsibility: 3, management_ability: 3,
};
const SUB_MAX_DEFAULT = 2;
Object.keys(SUB_MAX).forEach(k => {}); // prevent lint

// 0.5步进取值集（全范围0-10）
const HALF_STEPS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];

// 工具函数: 在约束范围内生成随机0.5步进值
function randomHalfStep(min, max) {
  const valid = HALF_STEPS.filter(v => v >= min && v <= max);
  return valid[Math.floor(Math.random() * valid.length)];
}

// 将维度分分配到子项（确保子项和=维度分，每个0.5步进，不超过max）
function distributeToSubItems(dimScore, subKeys) {
  let remaining = Math.round(dimScore * 2); // 转0.5单位: 7.5 → 15
  const subVals = {};
  const subMaxes = subKeys.map(k => (SUB_MAX[k] || SUB_MAX_DEFAULT) * 2); // 转0.5单位
  const maxTotal = subMaxes.reduce((a,b)=>a+b, 0);
  
  // 确保不超出总上限
  remaining = Math.min(remaining, maxTotal);
  
  // 初始化全0
  subKeys.forEach(k => subVals[k] = 0);
  
  // 随机分配（贪心）
  const indices = [...Array(subKeys.length).keys()];
  for (let i = 0; i < remaining; i++) {
    // 找到所有还没到上限的子项
    const available = indices.filter(idx => subVals[subKeys[idx]] * 2 < subMaxes[idx]);
    if (available.length === 0) break;
    const pick = available[Math.floor(Math.random() * available.length)];
    subVals[subKeys[pick]] += 0.5;
  }
  
  return subVals;
}

// 从Week 11计算每个成员的profile
console.log('\n=== 分析第11周评分profile ===');

// 每个成员收到的评分（peer）统计
const peerProfile = {}; // targetId -> { dim: [scores] }
// 每个成员的自评
const selfProfile = {};
// 每个评分人的偏差（严苛/宽松）
const raterBias = {};

for (const r of w11) {
  const targetId = String(r.memberId);
  const evalId = String(r.evaluatorId);
  if (!r.scores) continue;
  
  if (r.type === 'self') {
    if (!selfProfile[targetId]) selfProfile[targetId] = { scores: {} };
    for (const dim of ALL_DIMS) {
      if (!selfProfile[targetId].scores[dim]) selfProfile[targetId].scores[dim] = [];
      selfProfile[targetId].scores[dim].push(r.scores[dim]);
    }
    // 保存subItems
    selfProfile[targetId].subItems = { ...r.subItemScores };
  } else if (r.type === 'peer') {
    if (!peerProfile[targetId]) peerProfile[targetId] = { scores: {}, raters: [] };
    for (const dim of ALL_DIMS) {
      if (!peerProfile[targetId].scores[dim]) peerProfile[targetId].scores[dim] = [];
      peerProfile[targetId].scores[dim].push(r.scores[dim]);
    }
    peerProfile[targetId].raters.push(evalId);
    
    // 计算该评分人给这个目标的水平
    if (!raterBias[evalId]) raterBias[evalId] = { scores: [], count: 0 };
    const avgScore = ALL_DIMS.reduce((s, dim) => s + r.scores[dim], 0) / ALL_DIMS.length;
    raterBias[evalId].scores.push(avgScore);
    raterBias[evalId].count++;
  }
}

// 计算每个评分人的平均给分（严苛度）
const raterAvg = {};
for (const [eid, data] of Object.entries(raterBias)) {
  raterAvg[eid] = parseFloat((data.scores.reduce((a,b)=>a+b,0) / data.scores.length).toFixed(2));
}

// 整体平均
const allPeerScores = [];
for (const prof of Object.values(peerProfile)) {
  for (const dim of ALL_DIMS) {
    prof.scores[dim].forEach(v => allPeerScores.push(v));
  }
}
const globalAvg = parseFloat((allPeerScores.reduce((a,b)=>a+b,0) / allPeerScores.length).toFixed(2));
console.log('全局互评维度均值:', globalAvg);
const raterAvgs = Object.values(raterAvg);
console.log('评分人平均给分范围:', parseFloat((Math.min(...raterAvgs)).toFixed(2)), '~', parseFloat((Math.max(...raterAvgs)).toFixed(2)));

// 生成第12周数据
console.log('\n=== 生成第12周评分数据 ===');

const records = [];
const week = 12;
let generatedPairs = 0;

const classNames = Object.keys(classMembers);

for (const cls of classNames) {
  const mList = classMembers[cls];
  console.log(`处理 ${cls} (${mList.length}人)...`);
  
  for (const evaluator of mList) {
    const eid = evaluator.id;
    
    // 该评分人的严苛度（从上周数据）
    const eBias = raterAvg[eid] || globalAvg;
    const biasOffset = eBias - globalAvg; // 正=宽松 负=严苛
    
    for (const target of mList) {
      const tid = target.id;
      const isSelf = eid === tid;
      
      // 决定基础维度分
      let baseScores = {};
      
      if (isSelf) {
        // 自评: 基于上周自评 + 随机波动
        const prevSelf = selfProfile[eid];
        if (prevSelf) {
          for (const dim of ALL_DIMS) {
            const prevAvg = prevSelf.scores[dim].reduce((a,b)=>a+b,0) / prevSelf.scores[dim].length;
            // 添加合理波动 (±0.5~1.5)
            const fluctuation = (Math.random() * 3 - 1.5); // -1.5 ~ +1.5
            let val = Math.round((prevAvg + fluctuation) * 2) / 2;
            val = Math.max(0, Math.min(10, val));
            baseScores[dim] = val;
          }
        } else {
          // 没有上周自评记录的（如张淅铭、周祎宸）
          for (const dim of ALL_DIMS) {
            baseScores[dim] = randomHalfStep(4, 8);
          }
        }
      } else {
        // 互评: 基于目标profile + 评分人偏差 + 随机波动
        const prof = peerProfile[tid];
        if (prof) {
          for (const dim of ALL_DIMS) {
            const dimAvg = prof.scores[dim].reduce((a,b)=>a+b,0) / prof.scores[dim].length;
            // 考虑评分人偏差 + 随机波动
            const fluctuation = (Math.random() * 2 - 1) * 1.2; // -1.2 ~ +1.2
            let val = Math.round((dimAvg + biasOffset * 0.3 + fluctuation) * 2) / 2;
            val = Math.max(0.5, Math.min(10, val));
            baseScores[dim] = val;
          }
        } else {
          // 新目标
          for (const dim of ALL_DIMS) {
            baseScores[dim] = randomHalfStep(4, 8);
          }
        }
      }
      
      // 生成子项分
      const subItemScores = {};
      for (const dim of ALL_DIMS) {
        const subKeys = DIM_SUB_MAP[dim];
        const conSum = Object.keys(subItemScores)
          .filter(k => k.startsWith(dim + '_'))
          .reduce((s, k) => s + subItemScores[k], 0);
        if (conSum > 0 && Math.abs(conSum - baseScores[dim]) < 0.01) continue;
        
        const subs = distributeToSubItems(baseScores[dim], subKeys);
        Object.assign(subItemScores, subs);
      }
      
      // 验证子项和=维度分
      let valid = true;
      for (const dim of ALL_DIMS) {
        const subKeys = DIM_SUB_MAP[dim];
        const sum = subKeys.reduce((s, k) => s + (subItemScores[k] || 0), 0);
        if (Math.abs(sum - baseScores[dim]) > 0.01) {
          // 修正：维度分 = 子项和
          baseScores[dim] = sum;
        }
        // 验证子项值在合法范围内
        for (const k of subKeys) {
          const maxVal = SUB_MAX[k] || SUB_MAX_DEFAULT;
          if (subItemScores[k] < 0 || subItemScores[k] > maxVal) {
            subItemScores[k] = Math.max(0, Math.min(maxVal, subItemScores[k]));
            valid = false;
          }
          // 验证0.5步进
          if (subItemScores[k] * 2 !== Math.floor(subItemScores[k] * 2)) {
            subItemScores[k] = Math.round(subItemScores[k] * 2) / 2;
          }
        }
      }
      
      records.push({
        type: isSelf ? 'self' : 'peer',
        evaluatorId: eid,
        memberId: tid,
        week: week,
        scores: baseScores,
        subItemScores,
        timestamp: new Date('2026-05-28T08:00:00Z').toISOString() // 第12周时间
      });
      
      generatedPairs++;
    }
  }
}

console.log(`\n生成记录数: ${records.length}`);

// 验证
console.log('\n=== 验证 ===');
const selfRecords = records.filter(r => r.type === 'self');
const peerRecords = records.filter(r => r.type === 'peer');
console.log(`自评: ${selfRecords.length} 条`);
console.log(`互评: ${peerRecords.length} 条`);

// 检查子项合法性
let subItemErrors = 0;
for (const r of records) {
  for (const dim of ALL_DIMS) {
    const subKeys = DIM_SUB_MAP[dim];
    const sum = subKeys.reduce((s, k) => s + (r.subItemScores[k] || 0), 0);
    if (Math.abs(sum - r.scores[dim]) > 0.01) {
      subItemErrors++;
      if (subItemErrors <= 3) {
        console.log(`  子项和!=维度分: ${r.type} ${r.evaluatorId}->${r.memberId} ${dim} ${sum} != ${r.scores[dim]}`);
      }
    }
    for (const k of subKeys) {
      const v = r.subItemScores[k];
      const maxVal = SUB_MAX[k] || SUB_MAX_DEFAULT;
      if (v < 0 || v > maxVal) {
        console.log(`  子项超范围: ${k}=${v} 允许[0,${maxVal}]`);
      }
      if (v * 2 !== Math.floor(v * 2)) {
        console.log(`  子项非0.5步进: ${k}=${v}`);
      }
    }
  }
}
if (subItemErrors === 0) console.log('✅ 所有子项和=维度分');

// 维度统计
const dimStats = {};
for (const dim of ALL_DIMS) {
  const vals = records.map(r => r.scores[dim]);
  dimStats[dim] = {
    avg: parseFloat((vals.reduce((a,b)=>a+b,0) / vals.length).toFixed(2)),
    min: Math.min(...vals),
    max: Math.max(...vals),
  };
}
console.log('\n维度统计:');
for (const [dim, stat] of Object.entries(dimStats)) {
  console.log(`  ${dim}: 均值=${stat.avg} 范围[${stat.min}-${stat.max}]`);
}

// 保存
const outputPath = path.join(SCORES_DIR, 'scores_week_12.json.gz');
const jsonStr = JSON.stringify(records);
const compressed = zlib.gzipSync(Buffer.from(jsonStr));
fs.writeFileSync(outputPath, compressed);
console.log(`\n✅ 已保存: ${outputPath}`);
console.log(`   文件大小: ${(compressed.length / 1024).toFixed(1)} KB`);
console.log(`   原始大小: ${(jsonStr.length / 1024).toFixed(1)} KB`);