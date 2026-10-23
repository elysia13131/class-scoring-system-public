const BaseTool = require('./BaseTool');

class ChartGenerator extends BaseTool {
  constructor() {
    super({
      name: 'generate_chart',
      description: '将数据格式化为ECharts图表配置。请先用data_query工具获取数据，分析整理后传入本工具生成可视化。数据必须由AI自主提供，本工具不自动获取数据。可生成雷达图(radar)、折线图(line)、柱状图(bar)、饼图(pie)、散点图(scatter)',
      parameters: {
        chartType: { type: 'string', description: '图表类型: radar(雷达图)/line(折线图)/bar(柱状图)/pie(饼图)/scatter(散点图)', required: true },
        data: { type: 'object', description: `图表数据。不同chartType的data格式必须严格遵循以下规范：

【radar 雷达图】data必须使用以下两种格式之一：
  格式A（数组格式）：{ "values": [8.5, 7.0, 9.0, 8.0, 7.5, 8.5], "indicators": [{"name":"学习成绩","max":10},{"name":"体能素质","max":10},{"name":"人文素养","max":10},{"name":"遵章守纪","max":10},{"name":"班级贡献","max":10},{"name":"管理能力","max":10}] }
  格式B（键值对格式）：{ "study": 8.5, "fitness": 7.0, "literacy": 9.0, "discipline": 8.0, "contribution": 7.5, "management": 8.5 }

【line 折线图】data格式：{ "categories": ["第1周","第2周","第3周"], "series": [{ "name":"成绩", "data": [85, 90, 88] }], "yAxisName": "分数" }
  或简写：{ "xData": ["第1周","第2周","第3周"], "yData": [85, 90, 88] }

【bar 柱状图】data格式：{ "categories": ["成员A","成员B","成员C"], "series": [{ "name":"评分", "data": [85, 90, 78] }] }
  或简写：{ "xData": ["成员A","成员B","成员C"], "values": [85, 90, 78] }

【pie 饼图】data格式：{ "data": [{ "name":"类别A", "value": 30 }, { "name":"类别B", "value": 50 }, { "name":"类别C", "value": 20 }] }

【scatter 散点图】data格式：{ "data": [[10, 20], [15, 35], [20, 15]], "xAxisName": "X轴", "yAxisName": "Y轴" }

重要：必须严格按上述格式传入，不要自己发明字段名。建议先用data_query查询原始数据，然后按上述格式整理后传递给data参数`,
        required: true },
        title: { type: 'string', description: '图表标题', required: false }
      },
      category: 'charts'
    });
  }

  async execute(params, context) {
    const { chartType, data, title } = params;

    if (!data) {
      return { type: 'error', message: '缺少数据参数(data)，请先用data_query工具查询所需数据后再调用generate_chart' };
    }

    const generators = {
      radar: () => this._generateRadarChart(data, title),
      line: () => this._generateLineChart(data, title),
      bar: () => this._generateBarChart(data, title),
      pie: () => this._generatePieChart(data, title),
      scatter: () => this._generateScatterChart(data, title)
    };

    const config = generators[chartType]();
    if (!config) {
      return {
        type: 'error',
        message: `${chartType}图表生成失败：data数据格式不匹配。请按generate_chart工具data参数描述中的格式传入，不要自己发明字段名。` +
          (chartType === 'radar' ? '雷达图支持两种格式：格式A {"values":[8.5,7.0,...],"indicators":[{"name":"学习成绩","max":10},...]}；格式B {"study":8.5,"fitness":7.0,...}' :
           chartType === 'bar' ? '柱状图格式：{"categories":["名称A","名称B",...],"series":[{"name":"评分","data":[85,90,...]}]} 或简写 {"xData":[...],"values":[85,90,...]}' :
           chartType === 'line' ? '折线图格式：{"categories":["第1周","第2周",...],"series":[{"name":"分数","data":[85,90,...]}],"yAxisName":"分数"}' :
           chartType === 'pie' ? '饼图格式：{"data":[{"name":"类别A","value":30},{"name":"类别B","value":50},...]}' :
           '散点图格式：{"data":[[10,20],[15,35],...],"xAxisName":"X轴","yAxisName":"Y轴"}')
      };
    }

    return {
      type: 'echarts_config',
      chartType,
      config,
      renderHint: this._getRenderHint(chartType)
    };
  }

  _generateRadarChart(data, title) {
    const knownDimensions = { study: '学习成绩', fitness: '体能素质', literacy: '人文素养', discipline: '遵章守纪', contribution: '班级贡献', management: '管理能力' };

    const parseIndicatorsAndValues = () => {
      if (Array.isArray(data.values) && data.values.length > 0) {
        const indicators = data.indicators || data.values.map((_, i) => ({ name: `维度${i + 1}`, max: data.maxValue || 10 }));
        return { indicators, values: data.values, series: data.series };
      }

      if (Array.isArray(data.indicators) && data.indicators.length > 0 && Array.isArray(data.series)) {
        return { indicators: data.indicators, values: data.series[0]?.data || [], series: data.series };
      }

      if (data.scores && typeof data.scores === 'object') {
        const entries = Object.entries(data.scores).filter(([, v]) => typeof v === 'number');
        if (entries.length > 0) {
          const indicators = entries.map(([key]) => ({ name: knownDimensions[key] || key, max: data.maxValue || 10 }));
          const values = entries.map(([, v]) => v);
          return { indicators, values, series: null };
        }
      }

      const ownEntries = Object.entries(data).filter(([key]) => key !== 'indicators' && key !== 'values' && key !== 'series' && key !== 'seriesNames' && key !== 'maxValue' && key !== 'title');
      const numericEntries = ownEntries.filter(([, v]) => typeof v === 'number');
      if (numericEntries.length > 0) {
        const indicators = numericEntries.map(([key]) => ({ name: knownDimensions[key] || key, max: data.maxValue || 10 }));
        const values = numericEntries.map(([, v]) => v);
        return { indicators, values, series: null };
      }

      return null;
    };

    const parsed = parseIndicatorsAndValues();
    if (!parsed || parsed.values.length === 0) return null;

    const { indicators, values, series } = parsed;

    return {
      title: { text: title || '雷达图', left: 'center', textStyle: { fontSize: 14, fontWeight: 600, color: '#1f2937' } },
      tooltip: { trigger: 'item' },
      legend: { data: data.seriesNames || ['评分'], bottom: 0 },
      radar: { indicator: indicators, shape: 'polygon', splitNumber: 4, axisName: { color: '#6b7280', fontSize: 11 }, max: data.maxValue || 10 },
      series: series || [{
        type: 'radar',
        data: [{ value: values, name: '评分', areaStyle: { color: 'rgba(102,126,234,0.2)' }, lineStyle: { color: '#667eea', width: 2 }, itemStyle: { color: '#667eea' } }]
      }],
      color: ['#667eea', '#764ba2', '#f59e0b', '#10b981', '#ef4444', '#ec4899']
    };
  }

  _generateLineChart(data, title) {
    const xData = data.categories || data.xData || [];

    let seriesData = data.series || (data.yData ? [{ type: 'line', data: data.yData }] : []);

    if (xData.length === 0 || seriesData.length === 0) {
      const numericEntries = Object.entries(data).filter(([k]) => k !== 'yAxisName').filter(([, v]) => typeof v === 'number');
      if (numericEntries.length > 0 && seriesData.length === 0) {
        const sorted = numericEntries.sort(([a], [b]) => a.localeCompare(b, 'zh'));
        return this._generateLineChart({ categories: sorted.map(([k]) => k), yData: sorted.map(([, v]) => v), yAxisName: data.yAxisName }, title);
      }
    }

    if (xData.length === 0 || seriesData.length === 0) return null;

    return {
      title: { text: title || '折线图', left: 'center', textStyle: { fontSize: 14, fontWeight: 600 } },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: xData, boundaryGap: false },
      yAxis: { type: 'value', name: data.yAxisName || '' },
      series: seriesData.map(s => ({
        type: 'line',
        smooth: true,
        areaStyle: { opacity: 0.25 },
        lineStyle: { width: 2 },
        ...s
      })),
      color: ['#667eea', '#764ba2', '#f59e0b', '#10b981', '#ef4444', '#ec4899']
    };
  }

  _generateBarChart(data, title) {
    const categories = data.categories || data.xData || [];

    let seriesData = data.series || (data.values ? [{ type: 'bar', data: data.values }] : []);

    if (categories.length === 0 || seriesData.length === 0) {
      const numericEntries = Object.entries(data).filter(([k]) => k !== 'yAxisName').filter(([, v]) => typeof v === 'number');
      if (numericEntries.length > 0 && seriesData.length === 0) {
        const sorted = numericEntries.sort(([a], [b]) => a.localeCompare(b, 'zh'));
        return this._generateBarChart({ categories: sorted.map(([k]) => k), values: sorted.map(([, v]) => v), yAxisName: data.yAxisName }, title);
      }
    }

    if (categories.length === 0 || seriesData.length === 0) return null;

    return {
      title: { text: title || '柱状图', left: 'center', textStyle: { fontSize: 14, fontWeight: 600 } },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: { type: 'category', data: categories },
      yAxis: { type: 'value', name: data.yAxisName || '' },
      series: seriesData.map(s => ({
        type: 'bar',
        itemStyle: { borderRadius: [4, 4, 0, 0] },
        ...s
      })),
      color: ['#667eea', '#764ba2', '#f59e0b', '#10b981', '#ef4444', '#ec4899']
    };
  }

  _generatePieChart(data, title) {
    const items = data.data || data.items || data.values || [];

    if (!Array.isArray(items) || items.length === 0) return null;

    return {
      title: { text: title || '饼图', left: 'center', textStyle: { fontSize: 14, fontWeight: 600 } },
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: data.showLegend !== false ? { orient: 'vertical', left: 'left' } : undefined,
      series: [{
        type: 'pie',
        radius: ['40%', '70%'],
        data: items.map(i => typeof i === 'object' ? i : { value: i, name: '' }),
        emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0, 0, 0, 0.5)' } }
      }],
      color: ['#667eea', '#764ba2', '#f59e0b', '#10b981', '#ef4444', '#ec4899']
    };
  }

  _generateScatterChart(data, title) {
    const points = data.data || data.points || [];

    if (!Array.isArray(points) || points.length === 0) return null;

    return {
      title: { text: title || '散点图', left: 'center', textStyle: { fontSize: 14, fontWeight: 600 } },
      tooltip: { trigger: 'item' },
      xAxis: { type: 'value', name: data.xAxisName || '' },
      yAxis: { type: 'value', name: data.yAxisName || '' },
      series: [{
        type: 'scatter',
        data: points,
        symbolSize: data.symbolSize || 10,
        itemStyle: { color: '#667eea', opacity: 0.7 }
      }]
    };
  }

  _getRenderHint(chartType) {
    const hints = {
      radar: { recommendedWidth: 500, recommendedHeight: 400 },
      line: { recommendedWidth: 800, recommendedHeight: 400 },
      bar: { recommendedWidth: 700, recommendedHeight: 400 },
      pie: { recommendedWidth: 400, recommendedHeight: 400 },
      scatter: { recommendedWidth: 600, recommendedHeight: 450 }
    };
    return hints[chartType] || { recommendedWidth: 600, recommendedHeight: 400 };
  }
}

module.exports = ChartGenerator;
