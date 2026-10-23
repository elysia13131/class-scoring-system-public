const BaseTool = require('./BaseTool');
const path = require('path');
const fs = require('fs').promises;
const { getDataDir, getDataPath } = require('../../utils/dataPath');

class FileOperationTool extends BaseTool {
  constructor() {
    super({
      name: 'file_operations',
      description: '文件操作：查看可用数据文件、获取数据预览。当用户说"查看文件"、"数据文件"、"导出数据"时调用',
      parameters: {
        action: { type: 'string', description: 'list_files(列出文件) / get_data_preview(预览数据) / export_data(导出数据)', required: false },
        fileType: { type: 'string', description: '文件类型: scores/members/academic/fitness/rank/nominations', required: false },
        limit: { type: 'number', description: '返回条数限制', required: false }
      },
      category: 'files'
    });
  }

  async execute(params, context) {
    const { action = 'list_files', fileType, limit = 10 } = params;

    switch (action) {
      case 'list_files':
        return await this._listAvailableFiles();
      case 'get_data_preview':
        return await this._getDataPreview(fileType, limit);
      case 'export_data':
        return await this._exportData(fileType, context);
      default:
        throw new Error(`未知操作: ${action}`);
    }
  }

  async _listAvailableFiles() {
    const dataDir = getDataDir();
    const fileMap = {
      'members.json': { name: '成员信息', category: '基础数据' },
      'scores.json': { name: '评分汇总', category: '成绩数据' },
      'academic_scores.json': { name: '学术成绩', category: '成绩数据' },
      'fitness_scores.json': { name: '体能成绩', category: '成绩数据' },
      'rank_scores.json': { name: '排名成绩', category: '成绩数据' },
      'relationship_nominations.json': { name: '关系提名', category: '心理数据' }
    };

    const files = [];
    for (const [fileName, info] of Object.entries(fileMap)) {
      try {
        const filePath = path.join(dataDir, fileName);
        const stat = await fs.stat(filePath);
        files.push({
          fileName,
          ...info,
          size: `${(stat.size / 1024).toFixed(1)}KB`,
          modifiedAt: stat.mtime.toISOString().split('T')[0]
        });
      } catch (err) { }
    }

    const scoreFiles = [];
    try {
      const scoreDir = path.join(dataDir, 'scores');
      const entries = await fs.readdir(scoreDir);
      for (const entry of entries) {
        if (entry.endsWith('.json.gz')) {
          try {
            const stat = await fs.stat(path.join(scoreDir, entry));
            const weekMatch = entry.match(/week_(\d+)/);
            scoreFiles.push({ fileName: entry, week: weekMatch ? weekMatch[1] : '?', size: `${(stat.size / 1024).toFixed(1)}KB` });
          } catch (e) {}
        }
      }
    } catch (e) {}

    return {
      type: 'file_list',
      files,
      scoreFiles,
      totalFiles: files.length + scoreFiles.length
    };
  }

  async _getDataPreview(fileType, limit) {
    const fileMap = {
      scores: 'scores.json',
      members: 'members.json',
      academic: 'academic_scores.json',
      fitness: 'fitness_scores.json',
      rank: 'rank_scores.json',
      nominations: 'relationship_nominations.json'
    };

    const fileName = fileMap[fileType];
    if (!fileName) {
      return { type: 'error', error: `不支持的文件类型: ${fileType}，可选: ${Object.keys(fileMap).join('/')}` };
    }

    try {
      const filePath = getDataPath(fileName);
      const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));

      let previewData;
      let columns = [];

      if (Array.isArray(data)) {
        previewData = data.slice(0, limit).map(item => {
          if (item.password) { const { password, ...rest } = item; return rest; }
          return item;
        });
        if (previewData.length > 0) columns = Object.keys(previewData[0]);
      } else if (typeof data === 'object') {
        const keys = Object.keys(data).slice(0, limit);
        previewData = keys.map(key => ({ key, value: this._truncateValue(data[key]) }));
        columns = ['key', 'value'];
      }

      return {
        type: 'data_preview',
        fileType,
        fileName,
        totalCount: Array.isArray(data) ? data.length : Object.keys(data).length,
        columns,
        preview: previewData
      };
    } catch (err) {
      return { type: 'error', error: `读取文件失败: ${err.message}` };
    }
  }

  async _exportData(fileType, context) {
    const fileMap = {
      scores: 'scores.json',
      members: 'members.json',
      academic: 'academic_scores.json',
      fitness: 'fitness_scores.json',
      rank: 'rank_scores.json'
    };

    const fileName = fileMap[fileType || 'members'];
    if (!fileName) {
      return { type: 'error', error: `不支持导出的类型: ${fileType}` };
    }

    try {
      const filePath = getDataPath(fileName);
      const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      const exportData = fileType === 'members' && Array.isArray(data)
        ? data.map(({ password, ...rest }) => rest)
        : data;
      const exportName = `${fileType}_${Date.now()}.json`;

      const exportPath = getDataPath('exports');
      try { await fs.mkdir(exportPath, { recursive: true }); } catch (e) {}

      await fs.writeFile(path.join(exportPath, exportName), JSON.stringify(exportData, null, 2), 'utf-8');

      return {
        type: 'export_result',
        success: true,
        message: `数据导出成功！文件: ${exportName}`,
        exportPath: `/api/downloads/${exportName}`,
        recordCount: Array.isArray(data) ? data.length : Object.keys(data).length
      };
    } catch (err) {
      return { type: 'error', error: `导出失败: ${err.message}` };
    }
  }

  _truncateValue(val) {
    const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
    return str.length > 100 ? str.slice(0, 100) + '...' : str;
  }
}

module.exports = FileOperationTool;
