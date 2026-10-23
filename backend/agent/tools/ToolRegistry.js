class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (!tool || !tool.name) {
      throw new Error('无效的工具实例');
    }

    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] 工具 "${tool.name}" 已存在，将被覆盖`);
    }

    this.tools.set(tool.name, tool);
    return this;
  }

  get(name) {
    return this.tools.get(name) || null;
  }

  getAll() {
    return Array.from(this.tools.values());
  }

  count() {
    return this.tools.size;
  }

  getAvailableTools(isAdmin = false) {
    return this.getAll().map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      requireAuth: tool.requireAuth,
      category: tool.category
    }));
  }

  getSchemas() {
    return this.getAvailableTools();
  }

  getCategories() {
    const categories = {};
    for (const tool of this.getAll()) {
      const cat = tool.category || 'general';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push({
        name: tool.name,
        description: tool.description.split('。')[0],
        requireAuth: tool.requireAuth
      });
    }
    return categories;
  }

  async execute(name, params, context = {}) {
    const tool = this.get(name);
    if (!tool) {
      return { success: false, tool: name, error: `工具 "${name}" 不存在`, timestamp: new Date().toISOString() };
    }

    const validation = tool.validateParams(params);
    if (!validation.valid) {
      console.warn(`[ToolRegistry] 工具 ${name} 参数验证失败:`, validation.errors);
      return { success: false, tool: name, error: `参数验证失败: ${validation.errors.join('; ')}`, timestamp: new Date().toISOString() };
    }

    const startTime = Date.now();
    try {
      const result = await tool.execute(params, context);
      const executionTime = Date.now() - startTime;

      const formatted = tool.formatResult(result);
      formatted.executionTime = `${executionTime}ms`;

      if (formatted.isForm) {
        console.log(`[ToolRegistry] 工具 ${name} 返回交互表单: ${result.formType}`);
      } else if (result?.config || result?.type === 'echarts_config') {
        console.log(`[ToolRegistry] 工具 ${name} 返回图表配置`);
      } else {
        console.log(`[ToolRegistry] 工具 ${name} 执行成功 (${executionTime}ms)`);
      }

      return formatted;
    } catch (error) {
      console.error(`[ToolRegistry] 工具 ${name} 执行失败:`, error.message);
      return tool.formatError(error);
    }
  }

  has(name) {
    return this.tools.has(name);
  }

  listNames() {
    return Array.from(this.tools.keys());
  }
}

module.exports = ToolRegistry;
