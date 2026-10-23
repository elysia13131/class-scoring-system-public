const BaseTool = require('./BaseTool');

class ChartExportTool extends BaseTool {
  constructor() {
    super({
      name: 'chart_export',
      description: '导出图表为图片。当用户说"导出图片"、"导出图表"、"保存图片"、"下载图表"时调用。返回前端可用的导出配置，实际导出由前端ECharts完成',
      parameters: {
        chartType: { type: 'string', description: '图表类型: radar/line/bar/pie（默认radar）', required: false },
        format: { type: 'string', description: '格式: png(默认)/svg', required: false },
        pixelRatio: { type: 'number', description: '像素比(默认2高清)', required: false }
      },
      category: 'charts'
    });
  }

  async execute(params, context) {
    const { chartType = 'radar', format = 'png', pixelRatio = 2 } = params;

    const validTypes = ['radar', 'line', 'bar', 'pie'];
    if (!validTypes.includes(chartType)) {
      return {
        type: 'export_config',
        success: false,
        error: `不支持的图表类型: ${chartType}，可选: ${validTypes.join('/')}`
      };
    }

    const validFormats = ['png', 'svg'];
    if (!validFormats.includes(format)) {
      return {
        type: 'export_config',
        success: false,
        error: `不支持的格式: ${format}，可选: ${validFormats.join('/')}`
      };
    }

    return {
      type: 'export_config',
      success: true,
      exportConfig: {
        chartType,
        format,
        pixelRatio,
        filename: `${chartType}_chart_${Date.now()}.${format}`,
        backgroundColor: '#fff'
      },
      message: `请在图表右上角点击"导出图片"按钮进行${format.toUpperCase()}格式导出`
    };
  }
}

module.exports = ChartExportTool;
