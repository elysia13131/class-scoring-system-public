const BaseTool = require('./BaseTool');
const path = require('path');
const fs = require('fs').promises;
const zlib = require('zlib');
const { getDataPath } = require('../../utils/dataPath');
const { getCurrentWeek, getCurrentSemesterId } = require('../../utils/semester');

class DataQueryTool extends BaseTool {
  constructor() {
    super({
      name: 'data_query',
      description: '数据查询工具。直接获取系统原始数据，供AI自主分析判断。可查询评分数据、学习成绩、体能数据、成员信息、心情记录、关系提名、经历数据等。当需要获取具体数据来回答用户问题时调用，不限于预设分析，可灵活组合查询。管理员可查询所有数据。注意：查询scores/evaluation_status等评分相关数据时，务必先用available_weeks确认可用的周次列表，再指定week参数查询特定周次，不要假设只有当前周可用。判断谁未完成评分请优先使用evaluation_status（评分完成情况），返回每人的自评/互评状态及未完成名单，无需手动解析scores原始数据。',
      parameters: {
        dataType: { type: 'string', description: '数据类型: scores(六维评分，按被评人分组)/academic_scores(学习成绩/课程成绩)/fitness_scores(体能测试数据，★★★自动返回男女及格标准、女生班级、每人各项目是否及格详情及按班级汇总的及格/不及格名单，直接使用summary和passStandards)/rank_scores(排名成绩)/members(成员)/nominations(关系提名)/mood_records(心情记录)/experiences(经历)/available_weeks(可用周次列表★查询评分前先调用此类型确认有哪些周次可用)/classes(班级列表)/semesters(学期列表★查询有哪些学期、各学期起点日期与当前学期)/evaluation_status(评分完成情况，分析谁未完成自评/互评，优先使用此类型代替手动解析scores)', required: true },
        week: { type: 'number', description: '周次（查询评分、evaluation_status时使用，务必先用available_weeks确认哪些周次可用，不要假设只有当前周。周次为学期内周次，从1开始）', required: false },
        semesterId: { type: 'number', description: '学期ID（1=大一上,2=大一下,3=大二上,4=大二下...，查询特定学期的评分数据时使用，默认当前学期）', required: false },
        memberId: { type: 'string', description: '成员ID（查询特定成员数据）', required: false },
        memberIds: { type: 'string', description: '成员ID列表，逗号分隔（查询多个成员）', required: false },
        className: { type: 'string', description: '班级名称（筛选特定班级）', required: false },
        dimension: { type: 'string', description: '维度: study/fitness/literacy/discipline/contribution/management', required: false },
        scoreType: { type: 'string', description: '评分来源: self(自评)/peer(他评)/all(全部，默认)', required: false },
        includeDetails: { type: 'boolean', description: '是否包含子项明细（默认false）', required: false },
        month: { type: 'string', description: '月份筛选（体能数据使用，格式如2026-03）', required: false },
        limit: { type: 'number', description: '返回条数限制（可选，不传则返回全部数据）', required: false }
      },
      requireAuth: false,
      category: 'data'
    });

    this.dimensionNames = {
      study: '学习成绩',
      fitness: '体能素质',
      literacy: '人文素养',
      discipline: '遵章守纪',
      contribution: '班级贡献',
      management: '管理能力'
    };
  }

  async execute(params, context) {
    console.log(`[DataQueryTool] execute: dataType=${params.dataType}, context.isAdmin=${context?.isAdmin}, context.memberId=${context?.memberId}`);
    const dataType = params.dataType;
    switch (dataType) {
      case 'scores':
        return await this._queryScores(params, context);
      case 'members':
        return await this._queryMembers(params, context);
      case 'nominations':
        return await this._queryNominations(params, context);
      case 'mood_records':
        return await this._queryMoodRecords(params, context);
      case 'experiences':
        return await this._queryExperiences(params, context);
      case 'academic_scores':
        return await this._queryAcademicScores(params, context);
      case 'fitness_scores':
        return await this._queryFitnessScores(params, context);
      case 'rank_scores':
        return await this._queryRankScores(params, context);
      case 'available_weeks':
        return await this._queryAvailableWeeks();
      case 'classes':
        return await this._queryClasses();
      case 'semesters':
        return await this._querySemesters();
      case 'evaluation_status':
        return await this._queryEvaluationStatus(params, context);
      default:
        return { type: 'data_query', error: `未知数据类型: ${dataType}`, validTypes: ['scores', 'academic_scores', 'fitness_scores', 'rank_scores', 'members', 'nominations', 'mood_records', 'experiences', 'available_weeks', 'classes', 'semesters', 'evaluation_status'] };
    }
  }

  async _queryScores(params, context) {
    try {
      const week = params.week || this._getCurrentWeek();
      const semesterId = params.semesterId || this._getCurrentSemesterId();
      const allScores = await this._loadWeekScores(week, semesterId);
      const members = await this._getFullMembers();
      const nameMap = {};
      const classMap = {};
      members.forEach(m => { nameMap[m.id] = m.name; classMap[m.id] = m.class; });

      let targetIds = null;
      if (params.memberId) {
        targetIds = new Set([String(params.memberId)]);
      } else if (params.memberIds) {
        targetIds = new Set(params.memberIds.split(',').map(s => s.trim()).filter(Boolean));
      }
      if (params.className) {
        const resolved = this._resolveClassName(params.className, members);
        const classMemberIds = new Set(members.filter(m => m.class === resolved).map(m => m.id));
        if (targetIds) {
          targetIds = new Set([...targetIds].filter(id => classMemberIds.has(id)));
        } else {
          targetIds = classMemberIds;
        }
      }

      let filtered = allScores;
      if (targetIds) {
        filtered = allScores.filter(s => targetIds.has(String(s.memberId)));
      }
      if (params.scoreType && params.scoreType !== 'all') {
        filtered = filtered.filter(s => s.type === params.scoreType);
      }

      const grouped = {};
      for (const record of filtered) {
        const mid = String(record.memberId);
        if (!grouped[mid]) {
          grouped[mid] = {
            memberId: mid,
            memberName: nameMap[mid] || mid,
            class: classMap[mid] || '',
            week,
            scores: {},
            subItemScores: {},
            scoreTypes: [],
            evaluatedByIds: [],
            evaluatedByNames: [],
            hasSelfScore: false,
            totalEvaluations: 0,
          };
        }
        const g = grouped[mid];
        g.totalEvaluations++;
        const evalId = record.evaluatorId ? String(record.evaluatorId) : null;
        if (evalId && !g.evaluatedByIds.includes(evalId)) {
          g.evaluatedByIds.push(evalId);
          g.evaluatedByNames.push(nameMap[evalId] || evalId);
        }
        if (record.type && !g.scoreTypes.includes(record.type)) {
          g.scoreTypes.push(record.type);
        }
        if (record.type === 'self' && evalId === mid) {
          g.hasSelfScore = true;
        }
        if (record.scores) {
          for (const [dim, val] of Object.entries(record.scores)) {
            if (typeof val === 'number') {
              if (params.dimension && dim !== params.dimension) continue;
              g.scores[dim] = g.scores[dim]
                ? (g.scores[dim] + val) / 2
                : val;
            }
          }
        }
        if (params.includeDetails && record.subItemScores) {
          for (const [key, val] of Object.entries(record.subItemScores)) {
            if (typeof val === 'number') {
              if (!g.subItemScores[key]) g.subItemScores[key] = [];
              g.subItemScores[key].push(val);
            }
          }
        }
      }

      const evaluatorActivity = {};
      for (const record of allScores) {
        const eid = String(record.evaluatorId);
        if (!evaluatorActivity[eid]) {
          evaluatorActivity[eid] = { memberId: eid, memberName: nameMap[eid] || eid, hasSelfEval: false, peerEvalTargets: [], peerEvalTargetNames: [], totalPeerEvals: 0 };
        }
        const act = evaluatorActivity[eid];
        if (record.type === 'self' && eid === String(record.memberId)) {
          act.hasSelfEval = true;
        } else if (record.type === 'peer') {
          const targetId = String(record.memberId);
          if (!act.peerEvalTargets.includes(targetId)) {
            act.peerEvalTargets.push(targetId);
            act.peerEvalTargetNames.push(nameMap[targetId] || targetId);
          }
          act.totalPeerEvals++;
        }
      }

      let results = Object.values(grouped);
      if (params.dimension) {
        results = results.map(r => ({
          ...r,
          scores: { [params.dimension]: r.scores[params.dimension] || 0 },
          scoresFiltered: true,
          dimensionName: this.dimensionNames[params.dimension] || params.dimension
        }));
      }
      if (params.includeDetails) {
        results = results.map(r => {
          const averaged = {};
          for (const [key, vals] of Object.entries(r.subItemScores)) {
            averaged[key] = parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2));
          }
          return { ...r, subItemScores: averaged };
        });
      }

      const limit = params.limit || Infinity;
      const total = results.length;
      if (params.limit) results = results.slice(0, limit);

      for (const r of results) {
        for (const [dim, val] of Object.entries(r.scores)) {
          if (typeof val === 'number') r.scores[dim] = parseFloat(val.toFixed(2));
        }
      }

      return {
        type: 'data_query',
        dataType: 'scores',
        week,
        className: params.className || null,
        dimension: params.dimension ? this.dimensionNames[params.dimension] : null,
        scoreType: params.scoreType || 'all',
        totalRecords: total,
        returnedRecords: results.length,
        data: results,
        evaluatorActivity: Object.values(evaluatorActivity).filter(a => nameMap[a.memberId]),
        dataNote: '每条data记录是按"被评人"分组的(evaluatedByIds=谁评了TA, scoreTypes=TA收到了哪些评分)。evaluatorActivity是按"评分人"分组的(hasSelfEval=TA是否自评了, peerEvalTargets=TA互评了谁)。判断"谁未完成评分"请使用evaluatorActivity。',
        hint: params.limit && total > limit ? `共${total}条记录，已返回前${limit}条，可增大limit参数获取更多` : null
      };
    } catch (err) {
      return { type: 'data_query', dataType: 'scores', error: err.message };
    }
  }

  async _queryMembers(params, context) {
    try {
      const members = await this._getFullMembers();
      let results = members;

      if (params.className) {
        const resolved = this._resolveClassName(params.className, members);
        results = results.filter(m => m.class === resolved);
      }
      if (params.memberId) {
        results = results.filter(m => m.id === String(params.memberId));
      } else if (params.memberIds) {
        const ids = new Set(params.memberIds.split(',').map(s => s.trim()));
        results = results.filter(m => ids.has(m.id));
      }

      return {
        type: 'data_query',
        dataType: 'members',
        className: params.className || null,
        totalMembers: results.length,
        data: results
      };
    } catch (err) {
      return { type: 'data_query', dataType: 'members', error: err.message };
    }
  }

  async _queryNominations(params, context) {
    try {
      const nominationData = await this._loadNominationData();
      if (!nominationData) return { type: 'data_query', dataType: 'nominations', data: [], message: '暂无关系提名数据' };

      const members = await this._getFullMembers();
      const nameMap = {};
      members.forEach(m => { nameMap[m.id] = m.name; });

      let results = nominationData;
      if (params.memberId) {
        results = results.filter(r => String(r.evaluatorId) === String(params.memberId));
      } else if (!context.isAdmin && context.memberId) {
        results = results.filter(r => String(r.evaluatorId) === String(context.memberId));
      }
      if (params.className) {
        const resolved = this._resolveClassName(params.className, members);
        const classIds = new Set(members.filter(m => m.class === resolved).map(m => m.id));
        results = results.filter(r => classIds.has(String(r.evaluatorId)));
      }
      if (!context.isAdmin && context.memberId) {
        results = results.filter(r => String(r.evaluatorId) === String(context.memberId));
      }

      const limit = params.limit || Infinity;
      const total = results.length;
      results = params.limit ? results.slice(0, limit).map(r => ({
        evaluatorId: String(r.evaluatorId),
        evaluatorName: nameMap[String(r.evaluatorId)] || r.evaluatorId,
        positiveNominations: (r.positiveNominations || []).map(id => ({ id: String(id), name: nameMap[String(id)] || id })),
        negativeNominations: (r.negativeNominations || []).map(id => ({ id: String(id), name: nameMap[String(id)] || id })),
        moodTag: r.moodTag || null,
        selfAssessment: r.selfAssessment || null,
        copingStyle: r.copingStyle || [],
        timestamp: r.timestamp || null
      })) : results.map(r => ({
        evaluatorId: String(r.evaluatorId),
        evaluatorName: nameMap[String(r.evaluatorId)] || r.evaluatorId,
        positiveNominations: (r.positiveNominations || []).map(id => ({ id: String(id), name: nameMap[String(id)] || id })),
        negativeNominations: (r.negativeNominations || []).map(id => ({ id: String(id), name: nameMap[String(id)] || id })),
        moodTag: r.moodTag || null,
        selfAssessment: r.selfAssessment || null,
        copingStyle: r.copingStyle || [],
        timestamp: r.timestamp || null
      }));

      return {
        type: 'data_query',
        dataType: 'nominations',
        className: params.className || null,
        totalRecords: total,
        returnedRecords: results.length,
        data: results
      };
    } catch (err) {
      return { type: 'data_query', dataType: 'nominations', error: err.message };
    }
  }

  async _queryMoodRecords(params, context) {
    try {
      const nominationData = await this._loadNominationData();
      if (!nominationData) return { type: 'data_query', dataType: 'mood_records', data: [], message: '暂无心情记录数据' };

      const members = await this._getFullMembers();
      const nameMap = {};
      members.forEach(m => { nameMap[m.id] = m.name; });

      let results = nominationData.filter(r => r.moodTag);
      if (params.memberId) {
        results = results.filter(r => String(r.evaluatorId) === String(params.memberId));
      } else if (!context.isAdmin && context.memberId) {
        results = results.filter(r => String(r.evaluatorId) === String(context.memberId));
      }
      if (params.className) {
        const resolved = this._resolveClassName(params.className, members);
        const classIds = new Set(members.filter(m => m.class === resolved).map(m => m.id));
        results = results.filter(r => classIds.has(String(r.evaluatorId)));
      }
      if (!context.isAdmin && context.memberId) {
        results = results.filter(r => String(r.evaluatorId) === String(context.memberId));
      }

      const limit = params.limit || Infinity;
      const total = results.length;
      results = params.limit ? results.slice(0, limit).map(r => ({
        memberId: String(r.evaluatorId),
        memberName: nameMap[String(r.evaluatorId)] || r.evaluatorId,
        moodTag: r.moodTag,
        selfAssessment: r.selfAssessment || null,
        copingStyle: r.copingStyle || [],
        timestamp: r.timestamp || null
      })) : results.map(r => ({
        memberId: String(r.evaluatorId),
        memberName: nameMap[String(r.evaluatorId)] || r.evaluatorId,
        moodTag: r.moodTag,
        selfAssessment: r.selfAssessment || null,
        copingStyle: r.copingStyle || [],
        timestamp: r.timestamp || null
      }));

      return {
        type: 'data_query',
        dataType: 'mood_records',
        totalRecords: total,
        returnedRecords: results.length,
        data: results
      };
    } catch (err) {
      return { type: 'data_query', dataType: 'mood_records', error: err.message };
    }
  }

  async _queryExperiences(params, context) {
    try {
      const expPath = getDataPath( 'experiences.json');
      let list = [];
      try {
        const expData = JSON.parse(await fs.readFile(expPath, 'utf-8'));
        list = Array.isArray(expData) ? expData : [];
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const members = await this._getFullMembers();
      const nameMap = {};
      members.forEach(m => { nameMap[m.id] = m.name; });

      let results = list;
      if (params.memberId) {
        results = results.filter(e => String(e.memberId) === String(params.memberId));
      } else if (!context.isAdmin && context.memberId) {
        results = results.filter(e => String(e.memberId) === String(context.memberId));
      }
      if (!context.isAdmin && context.memberId) {
        results = results.filter(e => String(e.memberId) === String(context.memberId));
      }

      results = results.map(e => ({
        memberId: String(e.memberId),
        memberName: nameMap[String(e.memberId)] || e.memberId,
        type: e.type,
        data: e.data,
        createdAt: e.createdAt || null
      }));

      return {
        type: 'data_query',
        dataType: 'experiences',
        totalRecords: results.length,
        data: results
      };
    } catch (err) {
      return { type: 'data_query', dataType: 'experiences', error: err.message };
    }
  }

  async _queryAvailableWeeks() {
    try {
      const port = process.env.PORT || 3001;
      const axios = require('axios');
      const res = await axios.get(`http://127.0.0.1:${port}/api/available-scoring-weeks`);
      return {
        type: 'data_query',
        dataType: 'available_weeks',
        semesters: this._readConfig().semesters || [],
        currentSemesterId: this._getCurrentSemesterId(),
        data: res.data
      };
    } catch (err) {
      return { type: 'data_query', dataType: 'available_weeks', error: err.message };
    }
  }

  async _queryClasses() {
    try {
      const members = await this._getFullMembers();
      const classes = [...new Set(members.map(m => m.class).filter(Boolean))];
      const classInfo = classes.map(cls => {
        const classMembers = members.filter(m => m.class === cls);
        return {
          className: cls,
          memberCount: classMembers.length,
          backboneCount: classMembers.filter(m => m.isBackbone).length,
          members: classMembers.map(m => ({ id: m.id, name: m.name, isBackbone: m.isBackbone, position: m.position }))
        };
      });
      return {
        type: 'data_query',
        dataType: 'classes',
        totalClasses: classes.length,
        data: classInfo
      };
    } catch (err) {
      return { type: 'data_query', dataType: 'classes', error: err.message };
    }
  }

  async _querySemesters() {
    try {
      const config = this._readConfig();
      const semesters = Array.isArray(config.semesters) ? config.semesters : [];
      const currentSemesterId = this._getCurrentSemesterId();
      const currentWeek = this._getCurrentWeek();
      return {
        type: 'data_query',
        dataType: 'semesters',
        currentSemesterId,
        currentWeek,
        data: semesters.map(s => ({
          id: Number(s.id),
          name: s.name || '',
          startDate: s.startDate || '',
          isCurrent: Number(s.id) === Number(currentSemesterId)
        }))
      };
    } catch (err) {
      return { type: 'data_query', dataType: 'semesters', error: err.message };
    }
  }

  async _queryAcademicScores(params, context) {
    try {
      const filePath = getDataPath( 'academic_scores.json');
      let allData = [];
      try {
        const raw = JSON.parse(await fs.readFile(filePath, 'utf-8'));
        allData = Array.isArray(raw) ? raw : [];
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const members = await this._getFullMembers();
      const classMap = {};
      members.forEach(m => { classMap[m.id] = m.class; });

      let results = allData;
      if (params.memberId) {
        results = results.filter(r => String(r.memberId) === String(params.memberId));
      }
      if (params.className) {
        const resolved = this._resolveClassName(params.className, members);
        const classIds = new Set(members.filter(m => m.class === resolved).map(m => m.id));
        results = results.filter(r => classIds.has(String(r.memberId)));
      }

      const limit = params.limit || Infinity;
      const total = results.length;
      results = params.limit ? results.slice(0, limit).map(r => ({
        memberId: String(r.memberId),
        name: r.name || '',
        class: classMap[String(r.memberId)] || '',
        scores: r.scores || {}
      })) : results.map(r => ({
        memberId: String(r.memberId),
        name: r.name || '',
        class: classMap[String(r.memberId)] || '',
        scores: r.scores || {}
      }));

      return {
        type: 'data_query',
        dataType: 'academic_scores',
        className: params.className || null,
        totalRecords: total,
        returnedRecords: results.length,
        data: results
      };
    } catch (err) {
      return { type: 'data_query', dataType: 'academic_scores', error: err.message };
    }
  }

  async _queryFitnessScores(params, context) {
    try {
      const filePath = getDataPath( 'fitness_scores.json');
      let allData = [];
      try {
        const raw = JSON.parse(await fs.readFile(filePath, 'utf-8'));
        allData = Array.isArray(raw) ? raw : [];
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const members = await this._getFullMembers();
      const classMap = {};
      members.forEach(m => { classMap[m.id] = m.class; });

      const isFemaleMember = (id) => {
        if (!id) return false;
        const sid = String(id);
        return sid >= '1101' && sid <= '1113';
      };

      const femaleClassNames = [...new Set(members.filter(m => isFemaleMember(m.id)).map(m => m.class))];

      const standards = {
        standardName: '25岁以下体能及格标准',
        bmi: { male: { min: 18.5, max: 25.9 }, female: { min: 18.5, max: 23.9 } },
        items: {
          '三千米': { male: { pass: '13分35秒', value: 815 }, female: { pass: '16分05秒', value: 965 }, isTime: true, aliases: ['3000米'] },
          '仰卧卷腹': { male: { pass: 35, unit: '个' }, female: { pass: 27, unit: '个' }, isTime: false },
          '蛇形跑': { male: { pass: '20.4秒', value: 20.4 }, female: { pass: '22.2秒', value: 22.2 }, isTime: true },
          '曲臂悬垂/单杠': { male: { pass: '11个', value: 11 }, female: { pass: '36秒', value: 36 }, isTime: false, aliases: ['曲臂悬垂', '屈臂悬垂', '单杠', '引体向上', '屈臂悬垂/单杠', '曲臂悬垂/单杠', '单杠/引体向上'] }
        }
      };

      const resolveItemName = (itemName) => {
        for (const [key, std] of Object.entries(standards.items)) {
          if (itemName === key) return key;
          if (std.aliases && std.aliases.includes(itemName)) return key;
        }
        return null;
      };

      const parseThreeKmTime = (score) => {
        if (!score) return null;
        const str = String(score).trim();
        const m1 = str.match(/(\d+)[\''](\d+)/);
        if (m1) return parseInt(m1[1]) * 60 + parseInt(m1[2]);
        const m2 = str.match(/(\d+):(\d+)/);
        if (m2) return parseInt(m2[1]) * 60 + parseInt(m2[2]);
        const m3 = str.match(/(\d+)\.(\d+)/);
        if (m3) return parseInt(m3[1]) * 60 + parseInt(m3[2]);
        const digitsOnly = str.replace(/[^0-9]/g, '');
        if (digitsOnly.length === 4) return parseInt(digitsOnly.substring(0,2)) * 60 + parseInt(digitsOnly.substring(2,4));
        if (digitsOnly.length === 3) return parseInt(digitsOnly.substring(0,1)) * 60 + parseInt(digitsOnly.substring(1,3));
        const num = parseFloat(str);
        if (!isNaN(num)) return num;
        return null;
      };

      const parseSnakeRunTime = (score) => {
        if (!score) return null;
        const str = String(score).trim();
        const m1 = str.match(/(\d+)[\"\'\'](\d+)/);
        if (m1) return parseFloat(m1[1]) + parseFloat(m1[2]) / 10;
        const num = parseFloat(str);
        if (!isNaN(num)) return num;
        return null;
      };

      const checkPass = (itemName, score, isFemale) => {
        if (score === null || score === undefined || String(score).trim() === '' || String(score).trim() === '未参考') return null;
        const resolvedName = resolveItemName(itemName);
        if (!resolvedName) return null;
        const std = standards.items[resolvedName];
        if (!std) return null;

        if (itemName === 'BMI' || resolvedName === 'BMI') {
          const bmi = parseFloat(String(score));
          if (isNaN(bmi)) return null;
          const range = isFemale ? standards.bmi.female : standards.bmi.male;
          return bmi >= range.min && bmi <= range.max;
        }

        if (resolvedName === '三千米') {
          const timeSeconds = parseThreeKmTime(score);
          if (timeSeconds === null) return null;
          const passVal = isFemale ? std.female.value : std.male.value;
          return { pass: timeSeconds <= passVal, raw: score, seconds: timeSeconds, passLine: isFemale ? std.female.pass : std.male.pass };
        }

        if (resolvedName === '蛇形跑') {
          const timeVal = parseSnakeRunTime(score);
          if (timeVal === null) return null;
          const passVal = isFemale ? std.female.value : std.male.value;
          return { pass: timeVal <= passVal, raw: score, value: timeVal, passLine: isFemale ? std.female.pass : std.male.pass };
        }

        const num = parseFloat(String(score));
        if (isNaN(num)) return null;
        const passVal = isFemale ? std.female.value : std.male.value;
        if (std.isTime) return { pass: num <= passVal, raw: score, value: num, passLine: isFemale ? std.female.pass : std.male.pass };
        return { pass: num >= passVal, raw: score, value: num, passLine: isFemale ? std.female.pass : std.male.pass };
      };

      let results = allData;
      if (params.memberId) {
        results = results.filter(r => String(r.memberId) === String(params.memberId));
      }
      if (params.className) {
        const resolved = this._resolveClassName(params.className, members);
        const classIds = new Set(members.filter(m => m.class === resolved).map(m => m.id));
        results = results.filter(r => classIds.has(String(r.memberId)));
      }

      const month = params.month || null;
      const limit = params.limit || Infinity;
      const total = results.length;
      results = results.slice(0, limit).map(r => {
        let history = r.history || [];
        if (month) {
          history = history.filter(h => h.month === month);
        }
        return {
          memberId: String(r.memberId),
          name: r.name || '',
          class: classMap[String(r.memberId)] || '',
          history: history.map(h => ({
            month: h.month,
            scores: h.scores || {},
            timestamp: h.timestamp || null
          })),
          latestMonth: (history.sort((a,b) => b.month.localeCompare(a.month))[0] || {}).month || null,
          latestScores: (history.sort((a,b) => b.month.localeCompare(a.month))[0] || {}).scores || {}
        };
      });

      const passFailSummary = results.map(r => {
        const isFemale = isFemaleMember(r.memberId);
        const itemResults = {};
        let failItems = [];
        let passItems = [];
        let unreferencedItems = [];

        const itemsToCheck = { ...r.latestScores };
        // 如果没有BMI字段但有身高体重，自动补充BMI
        if (!itemsToCheck['BMI'] && itemsToCheck['身高'] && itemsToCheck['体重']) {
          itemsToCheck['BMI'] = null;
        }

        for (const [item, score] of Object.entries(itemsToCheck)) {
          if (['备注', '分数', '身高', '体重'].includes(item)) continue;
          const result = checkPass(item, score, isFemale);
          if (item === 'BMI') {
            const height = r.latestScores['身高'];
            const weight = r.latestScores['体重'];
            if (height && weight) {
              let h = parseFloat(String(height));
              let w = parseFloat(String(weight));
              if (!isNaN(h) && h > 0 && h < 3) h = h * 100;
              if (!isNaN(h) && !isNaN(w) && h > 0 && w > 0) {
                const bmi = w / ((h/100) * (h/100));
                const bmiRounded = Math.round(bmi * 10) / 10;
                const bmiRange = isFemale ? standards.bmi.female : standards.bmi.male;
                const bmiPass = bmiRounded >= bmiRange.min && bmiRounded <= bmiRange.max;
                itemResults[item] = { pass: bmiPass, value: bmiRounded, passLine: `${bmiRange.min}-${bmiRange.max}` };
                if (bmiPass) passItems.push(item); else failItems.push(item);
                continue;
              }
            }
            if (result === null) { unreferencedItems.push(item); itemResults[item] = { pass: null, reason: '未参考或无数据' }; }
            else if (result === true) { passItems.push(item); itemResults[item] = { pass: true }; }
            else if (result === false) { failItems.push(item); itemResults[item] = { pass: false }; }
            continue;
          }
          if (result === null) {
            unreferencedItems.push(item);
            itemResults[item] = { pass: null, reason: '未参考' };
          } else if (result === true) {
            passItems.push(item);
            itemResults[item] = { pass: true };
          } else if (result.pass === false) {
            failItems.push(item);
            itemResults[item] = result;
          } else {
            passItems.push(item);
            itemResults[item] = result;
          }
        }

        return {
          memberId: r.memberId,
          name: r.name,
          class: r.class,
          isFemale,
          month: r.latestMonth,
          itemResults,
          failItems,
          failCount: failItems.length,
          isPass: failItems.length === 0 && unreferencedItems.length === 0,
          isUnreference: unreferencedItems.length > 0 && failItems.length === 0,
          isFail: failItems.length > 0
        };
      });

      const totalMembers = passFailSummary.length;
      const passedMembers = passFailSummary.filter(r => r.isPass);
      const failedMembers = passFailSummary.filter(r => r.isFail);
      const unreferencedMembers = passFailSummary.filter(r => r.isUnreference);

      const failByClass = {};
      failedMembers.forEach(r => {
        if (!failByClass[r.class]) failByClass[r.class] = [];
        failByClass[r.class].push({ memberId: r.memberId, name: r.name, failItems: r.failItems });
      });

      return {
        type: 'data_query',
        dataType: 'fitness_scores',
        className: params.className || null,
        month: month || passFailSummary.filter(r => r.month).sort((a,b) => b.month.localeCompare(a.month))[0]?.month || null,
        totalRecords: total,
        returnedRecords: results.length,
        femaleClassNames,
        passStandards: standards,
        summary: {
          totalMembers,
          totalPassed: passedMembers.length,
          totalFailed: failedMembers.length,
          totalUnreferenced: unreferencedMembers.length,
          failedList: failedMembers.map(r => ({ memberId: r.memberId, name: r.name, class: r.class, failItems: r.failItems })),
          passList: passedMembers.map(r => ({ memberId: r.memberId, name: r.name, class: r.class })),
          failByClass
        },
        data: results,
        passFailSummary
      };
    } catch (err) {
      return { type: 'data_query', dataType: 'fitness_scores', error: err.message };
    }
  }

  async _queryRankScores(params, context) {
    try {
      const filePath = getDataPath( 'rank_scores.json');
      let allData = [];
      try {
        const raw = JSON.parse(await fs.readFile(filePath, 'utf-8'));
        allData = Array.isArray(raw) ? raw : [];
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const members = await this._getFullMembers();
      const classMap = {};
      members.forEach(m => { classMap[m.id] = m.class; });

      let results = allData;
      if (params.memberId) {
        results = results.filter(r => String(r.memberId) === String(params.memberId));
      }
      if (params.className) {
        const resolved = this._resolveClassName(params.className, members);
        const classIds = new Set(members.filter(m => m.class === resolved).map(m => m.id));
        results = results.filter(r => classIds.has(String(r.memberId)));
      }

      const limit = params.limit || Infinity;
      const total = results.length;
      results = params.limit ? results.slice(0, limit).map(r => ({
        memberId: String(r.memberId),
        name: r.name || '',
        class: classMap[String(r.memberId)] || '',
        semesterScores: r.semesterScores || [],
        totalScores: r.totalScores || [],
        totalRanks: r.totalRanks || [],
        yearRanks: r.yearRanks || []
      })) : results.map(r => ({
        memberId: String(r.memberId),
        name: r.name || '',
        class: classMap[String(r.memberId)] || '',
        semesterScores: r.semesterScores || [],
        totalScores: r.totalScores || [],
        totalRanks: r.totalRanks || [],
        yearRanks: r.yearRanks || []
      }));

      return {
        type: 'data_query',
        dataType: 'rank_scores',
        className: params.className || null,
        totalRecords: total,
        returnedRecords: results.length,
        data: results
      };
    } catch (err) {
      return { type: 'data_query', dataType: 'rank_scores', error: err.message };
    }
  }

  async _queryEvaluationStatus(params, context) {
    try {
      const week = params.week || this._getCurrentWeek();
      const semesterId = params.semesterId || this._getCurrentSemesterId();
      const members = await this._getFullMembers();
      let targetMembers = members;
      if (params.className) {
        const resolved = this._resolveClassName(params.className, members);
        targetMembers = members.filter(m => m.class === resolved);
      }

      const allScores = await this._loadWeekScores(week, semesterId);

      const evalByEvaluator = {};
      const evalByTarget = {};
      for (const record of allScores) {
        const eid = String(record.evaluatorId);
        const mid = String(record.memberId);
        if (!evalByEvaluator[eid]) evalByEvaluator[eid] = { selfCount: 0, peerCount: 0, selfTargets: [], peerTargets: [] };
        if (!evalByTarget[mid]) evalByTarget[mid] = { selfCount: 0, peerCount: 0 };
        if (record.type === 'self' && eid === mid) {
          evalByEvaluator[eid].selfCount++;
          evalByEvaluator[eid].selfTargets.push(mid);
          evalByTarget[mid].selfCount++;
        } else if (record.type === 'peer') {
          evalByEvaluator[eid].peerCount++;
          evalByEvaluator[eid].peerTargets.push(mid);
          evalByTarget[mid].peerCount++;
        }
      }

      const classMemberCount = {};
      for (const m of members) {
        if (!classMemberCount[m.class]) classMemberCount[m.class] = 0;
        classMemberCount[m.class]++;
      }

      const selfScoredCount = targetMembers.filter(m => evalByEvaluator[m.id]?.selfCount > 0).length;
      const peerCompleteCount = targetMembers.filter(m => {
        const clsCount = classMemberCount[m.class] || 1;
        return (evalByEvaluator[m.id]?.peerCount || 0) >= clsCount - 1;
      }).length;

      const memberStatus = targetMembers.map(m => {
        const evalData = evalByEvaluator[m.id] || { selfCount: 0, peerCount: 0, selfTargets: [], peerTargets: [] };
        const targetData = evalByTarget[m.id] || { selfCount: 0, peerCount: 0 };
        const expectedPeers = (classMemberCount[m.class] || 1) - 1;
        const peerEvalCount = evalData.peerCount;
        return {
          memberId: m.id,
          name: m.name,
          class: m.class,
          hasSelfScored: evalData.selfCount > 0,
          peerEvalCount,
          expectedPeerCount: expectedPeers,
          peerEvalComplete: peerEvalCount >= expectedPeers,
          totalEvalsGiven: evalData.selfCount + evalData.peerCount,
          receivedSelfCount: targetData.selfCount,
          receivedPeerCount: targetData.peerCount,
          peerTargets: evalData.peerTargets.slice(0, 5),
        };
      });

      const incompleteSelf = memberStatus.filter(m => !m.hasSelfScored);
      const noPeerEval = memberStatus.filter(m => !m.peerEvalComplete);

      // 去重合并：未完成自评 OR 未完成互评 的所有成员
      const allIncomplete = [];
      const seenIds = new Set();
      for (const m of [...incompleteSelf, ...noPeerEval]) {
        if (!seenIds.has(m.memberId)) {
          seenIds.add(m.memberId);
          allIncomplete.push({
            memberId: m.memberId,
            name: m.name,
            class: m.class,
            missingSelf: !m.hasSelfScored,
            missingPeer: !m.peerEvalComplete,
          });
        }
      }

      const classSummary = [];
      const classNames = [...new Set(targetMembers.map(m => m.class).filter(Boolean))];
      for (const cls of classNames) {
        const clsMembers = memberStatus.filter(m => m.class === cls);
        const clsSelfDone = clsMembers.filter(m => m.hasSelfScored).length;
        const clsPeerDone = clsMembers.filter(m => m.peerEvalComplete).length;
        classSummary.push({
          className: cls,
          totalMembers: clsMembers.length,
          selfScored: clsSelfDone,
          selfCompletionRate: parseFloat((clsSelfDone / clsMembers.length * 100).toFixed(1)),
          peerEvalActive: clsPeerDone,
          peerCompletionRate: parseFloat((clsPeerDone / clsMembers.length * 100).toFixed(1)),
        });
      }

      return {
        type: 'data_query',
        dataType: 'evaluation_status',
        week,
        className: params.className || null,
        totalMembers: targetMembers.length,
        selfScoredCount,
        selfCompletionRate: parseFloat((selfScoredCount / targetMembers.length * 100).toFixed(1)),
        selfMissedCount: targetMembers.length - selfScoredCount,
        selfMissedMembers: incompleteSelf.map(m => ({ memberId: m.memberId, name: m.name, class: m.class })),
        peerActiveCount: peerCompleteCount,
        peerCompletionRate: parseFloat((peerCompleteCount / targetMembers.length * 100).toFixed(1)),
        peerInactiveCount: targetMembers.length - peerCompleteCount,
        peerInactiveMembers: noPeerEval.map(m => ({ memberId: m.memberId, name: m.name, class: m.class })),
        memberStatus,
        classSummary,
        allIncomplete,
        summary: `第${week}周：共${targetMembers.length}人，自评完成${selfScoredCount}人（${(selfScoredCount/targetMembers.length*100).toFixed(1)}%），${incompleteSelf.length}人未自评；互评完成${peerCompleteCount}人（${(peerCompleteCount/targetMembers.length*100).toFixed(1)}%），${noPeerEval.length}人未互评；去重后${allIncomplete.length}人未完成全部评分`,
      };
    } catch (err) {
      return { type: 'data_query', dataType: 'evaluation_status', error: err.message };
    }
  }

  _readConfig() {
    try {
      const configPath = getDataPath('config.json');
      return JSON.parse(require('fs').readFileSync(configPath, 'utf-8'));
    } catch { return {}; }
  }

  _getCurrentSemesterId() {
    return getCurrentSemesterId();
  }

  _getCurrentWeek() {
    return getCurrentWeek();
  }

  async _getFullMembers() {
    try {
      const filePath = getDataPath( 'members.json');
      const raw = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      const list = Array.isArray(raw) ? raw : (raw.members || []);
      return list.map(m => ({
        id: String(m.id || m.memberId || ''),
        name: m.name || m.nickname || '',
        class: m.class || '',
        mbti: m.mbti || '',
        birthday: m.birthday || '',
        isBackbone: m.isBackbone || false,
        position: m.position || '',
        hobbies: m.hobbies || ''
      })).filter(m => m.id);
    } catch (e) { return []; }
  }

  _resolveClassName(input, members) {
    if (!input) return input;
    const allClasses = [...new Set(members.map(m => m.class).filter(Boolean))];
    if (allClasses.includes(input)) return input;
    const inputLower = input.toLowerCase();
    for (const cls of allClasses) {
      if (cls.toLowerCase() === inputLower) return cls;
    }
    for (const cls of allClasses) {
      if (cls.includes(input) || input.includes(cls)) return cls;
    }
    const inputClean = input.replace(/[班级组队]/g, '');
    for (const cls of allClasses) {
      const clsClean = cls.replace(/[班级组队]/g, '');
      if (clsClean === inputClean) return cls;
    }
    const numMap = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10', '十一': '11', '十二': '12' };
    const inputNum = input.replace(/[班级组队]/g, '').split('').map(c => numMap[c] || c).join('');
    for (const cls of allClasses) {
      const clsNum = cls.replace(/[班级组队]/g, '').split('').map(c => numMap[c] || c).join('');
      if (clsNum === inputNum) return cls;
    }
    let bestMatch = null;
    let bestScore = 0;
    for (const cls of allClasses) {
      let score = 0;
      const shorter = cls.length < input.length ? cls : input;
      const longer = cls.length < input.length ? input : cls;
      for (let i = 0; i < shorter.length; i++) {
        if (longer.includes(shorter[i])) score++;
      }
      score = score / Math.max(cls.length, input.length);
      if (score > bestScore) { bestScore = score; bestMatch = cls; }
    }
    if (bestScore >= 0.5) return bestMatch;
    return input;
  }

  async _loadWeekScores(week, semesterId) {
    if (!week) return [];
    const dataDir = getDataPath( 'scores');
    const sid = semesterId || this._getCurrentSemesterId();
    const filePath = path.join(dataDir, `semester_${sid}`, `scores_week_${week}.json.gz`);
    try {
      const compressed = await fs.readFile(filePath);
      const buffer = await new Promise((resolve, reject) => {
        zlib.unzip(compressed, (err, result) => err ? reject(err) : resolve(result));
      });
      return JSON.parse(buffer.toString());
    } catch (err) {
      try {
        const mainPath = getDataPath( 'scores.json');
        const data = JSON.parse(await fs.readFile(mainPath, 'utf-8'));
        return Array.isArray(data) ? data : [];
      } catch (e) { return []; }
    }
  }

  async _loadNominationData() {
    try {
      const dataPath = getDataPath( 'relationship_nominations.json');
      return JSON.parse(await fs.readFile(dataPath, 'utf-8'));
    } catch (e) { return null; }
  }
}

module.exports = DataQueryTool;
