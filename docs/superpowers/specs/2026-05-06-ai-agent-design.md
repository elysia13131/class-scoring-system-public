# AI Agent 智能助手系统设计文档

> **创建日期：** 2026-05-06
> **状态：** 待用户审查确认
> **版本：** v1.0

---

## 1. 项目概述

### 1.1 目标

构建一个**全能综合型AI Agent智能助手**，集成到现有的班级评分系统中，具备以下核心能力：

- **系统功能调用**：调用所有现有系统功能（成绩分析、心理气象站、文件操作、系统管理）
- **长短期记忆**：三级记忆系统（短期会话记忆、长期持久化记忆、偏好画像）
- **个性化适应**：语言风格自适应、交互习惯学习、偏好匹配
- **图表渲染**：支持输出并渲染各种图表（雷达图、趋势图、柱状图等）
- **权限隔离**：区分普通成员和管理员，基础权限隔离模型
- **隐私保护**：数据访问控制、敏感信息过滤

### 1.2 用户需求总结

| 需求维度 | 具体要求 |
|---------|---------|
| **定位** | 全能综合型（系统助手 + 通用对话 + 心理关怀） |
| **记忆系统** | 个性化偏好 + 对话历史上下文 + 语言风格适应 |
| **权限模型** | 基础权限隔离（普通成员看自己的数据，管理员可管理） |
| **功能集成** | 成绩分析 + 文件操作 + 心理气象站 + 系统管理（需管理员模式） |
| **AI模型** | 国产大模型 DeepSeek |
| **部署方式** | 嵌入式模块（集成到现有架构中） |

---

## 2. 技术架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    AI Agent 系统架构                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                   前端层 (React)                     │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │   │
│  │  │ChatUI    │ │ChartRender│ │MemoryView│ │AuthCtrl│ │   │
│  │  │对话界面   │ │图表渲染   │ │记忆管理  │ │权限控制│ │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────┘ │   │
│  └─────────────────────────┬───────────────────────────┘   │
│                            │ WebSocket + REST API          │
│  ┌─────────────────────────▼───────────────────────────┐   │
│  │                   后端层 (Express)                   │   │
│  │                                                     │   │
│  │  ┌─────────────────────────────────────────────┐   │   │
│  │  │              Agent Core (核心引擎)           │   │   │
│  │  │                                            │   │   │
│  │  │  ┌────────┐   ┌────────┐   ┌────────────┐  │   │   │
│  │  │  │意图识别│ → │任务规划│ → │工具执行引擎  │  │   │   │
│  │  │  └────────┘   └────────┘   └────────────┘  │   │   │
│  │  └─────────────────────────────────────────────┘   │   │
│  │                                                     │   │
│  │  ┌─────────────────────────────────────────────┐   │   │
│  │  │              记忆系统 (Memory System)        │   │   │
│  │  │                                            │   │   │
│  │  │  ┌────────┐  ┌────────┐  ┌────────────┐   │   │   │
│  │  │  │短期记忆│  │长期记忆│  │偏好画像     │   │   │   │
│  │  │  │Session │  │Profile │  │User Profile │   │   │   │
│  │  │  └────────┘  └────────┘  └────────────┘   │   │   │
│  │  └─────────────────────────────────────────────┘   │   │
│  │                                                     │   │
│  │  ┌─────────────────────────────────────────────┐   │   │
│  │  │              工具集 (Tool Kit)               │   │   │
│  │  │                                            │   │   │
│  │  │  ┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐│   │   │
│  │  │  │成绩  ││心理  ││文件  ││管理  ││图表  ││   │   │
│  │  │  │分析  ││气象  ││操作  ││系统  ││生成  ││   │   │
│  │  │  └──────┘└──────┘└──────┘└──────┘└──────┘│   │   │
│  │  └─────────────────────────────────────────────┘   │   │
│  └──────────────────────────┬──────────────────────────┘   │
│                            │                              │
│                   ┌────────▼────────┐                      │
│                   │  DeepSeek API   │                      │
│                   └─────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 技术选型

| 层级 | 技术 | 说明 |
|------|------|------|
| **前端框架** | React 18 + Vite | 与现有系统一致 |
| **UI库** | TailwindCSS + Lucide Icons | 现代化UI设计 |
| **图表库** | ECharts 5.x | 已有依赖，支持多种图表 |
| **后端框架** | Express 4.x | 与现有系统一致 |
| **AI模型** | DeepSeek API | 国产大模型，成本低 |
| **实时通信** | Socket.io | 已有依赖，支持流式响应 |
| **数据存储** | JSON文件 (gzip压缩) | 与现有存储方案一致 |

### 2.3 文件结构设计

```
backend/
├── agent/                          # AI Agent 模块
│   ├── index.js                    # Agent 入口和路由
│   ├── core/
│   │   ├── Engine.js              # 核心引擎（意图识别、任务规划）
│   │   ├── IntentClassifier.js     # 意图分类器
│   │   ├── TaskPlanner.js          # 任务规划器
│   │   └── ResponseGenerator.js    # 响应生成器
│   ├── memory/
│   │   ├── MemoryManager.js        # 记忆管理器（协调三级记忆）
│   │   ├── ShortTermMemory.js      # 短期记忆（会话级）
│   │   ├── LongTermMemory.js       # 长期记忆（跨会话）
│   │   └── UserProfile.js          # 偏好画像
│   ├── tools/
│   │   ├── BaseTool.js            # 工具基类
│   │   ├── ToolRegistry.js         # 工具注册中心
│   │   ├── ScoreAnalysisTool.js    # 成绩分析工具
│   │   ├── PsychologyTool.js       # 心理气象站工具
│   │   ├── FileOperationTool.js    # 文件操作工具
│   │   ├── SystemManagementTool.js # 系统管理工具（管理员）
│   │   └── ChartGenerator.js       # 图表生成器
│   ├── llm/
│   │   ├── DeepSeekClient.js       # DeepSeek API 客户端
│   │   └── PromptBuilder.js        # 提示词构建器
│   └── auth/
│       └── PermissionChecker.js    # 权限检查中间件
│
frontend/src/
├── components/
│   └── agent/                     # AI Agent 组件
│       ├── ChatContainer.jsx       # 对话容器（独立滚动区域）
│       ├── ChatMessage.jsx         # 单条消息组件
│       ├── ChatInput.jsx           # 输入框组件
│       ├── ChartRenderer.jsx       # 图表渲染组件
│       ├── MemoryDashboard.jsx     # 记忆管理面板
│       ├── ToolBox.jsx             # 工具箱组件
│       └── AdminPanel.jsx          # 管理员面板
│
data/
├── agent_sessions/                 # 会话数据（gzip压缩）
│   └── session_{memberId}_{date}.json.gz
├── agent_memories/                 # 长期记忆数据
│   └── memory_{memberId}.json
├── agent_profiles/                 # 用户偏好画像
│   └── profile_{memberId}.json
└── agent_configs/                  # Agent配置
    └── config.json
```

---

## 3. 核心模块详细设计

### 3.1 三级记忆系统

#### 3.1.1 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                     记忆系统 (Memory System)                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              第一层：短期记忆 (Session Memory)       │   │
│  │                                                     │   │
│  │  • 存储位置：内存 / Redis                            │   │
│  │  • 生命周期：当前会话（浏览器关闭后清除）               │   │
│  │  • 内容：                                            │   │
│  │    - 当前对话上下文（最近N轮对话）                    │   │
│  │    - 临时查询结果                                   │   │
│  │    - 中间计算状态                                   │   │
│  │  • 容量：10-20轮对话                                 │   │
│  └─────────────────────────────────────────────────────┘   │
│                           ↓                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              第二层：长期记忆 (Long-term Memory)      │   │
│  │                                                     │   │
│  │  • 存储位置：JSON文件 (data/agent_memories/)         │   │
│  │  • 生命周期：持久化（跨会话保留）                      │   │
│  │  • 内容：                                            │   │
│  │    - 重要对话摘要（自动提取）                        │   │
│  │    - 用户关注的数据趋势                              │   │
│  │    - 常见问题与答案                                  │   │
│  │    - 学习进度记录                                    │   │
│  │  • 更新策略：每次会话结束时合并                       │   │
│  └─────────────────────────────────────────────────────┘   │
│                           ↓                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              第三层：偏好画像 (User Profile)          │   │
│  │                                                     │   │
│  │  • 存储位置：JSON文件 (data/agent_profiles/)         │   │
│  │  • 生命周期：永久（手动清除）                         │   │
│  │  • 内容：                                            │   │
│  │    - 语言风格适应（正式/随意/幽默等）                 │   │
│  │    - 偏好的回复长度（简洁/详细）                     │   │
│  │    - 常用功能快捷方式                                │   │
│  │    - 专业术语使用习惯                                │   │
│  │    - 交互频率统计                                    │   │
│  │  • 更新策略：渐进式学习，定期优化                     │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              记忆管理器 (Memory Manager)             │   │
│  │                                                     │   │
│  │  职责：                                              │   │
│  │  • 协调三级记忆的读写                               │   │
│  │  • 自动提取重要信息存入长期记忆                      │   │
│  │  • 分析用户行为更新偏好画像                          │   │
│  │  • 记忆检索与相关性排序                             │   │
│  │  • 隐私保护（敏感信息过滤）                          │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

#### 3.1.2 数据结构定义

**短期记忆结构 (ShortTermMemory):**
```javascript
{
  memberId: "101",
  sessionId: "uuid-xxx",
  messages: [
    { role: "user", content: "查看我的成绩", timestamp: "2026-05-06T15:30:00Z" },
    { role: "assistant", content: "您的成绩是...", timestamp: "2026-05-06T15:30:01Z" }
  ],
  context: {
    currentTask: "成绩查询",
    lastQuery: { type: "query_scores", params: { memberId: "101" } },
    pendingActions: []
  },
  metadata: {
    createdAt: "2026-05-06T15:28:00Z",
    lastActivityAt: "2026-05-06T15:30:01Z",
    messageCount: 18
  }
}
```

**长期记忆结构 (LongTermMemory):**
```javascript
{
  memberId: "101",
  summaries: [
    {
      date: "2026-05-06",
      summary: "用户关心体能成绩提升，特别是三千米跑和引体向上",
      keywords: ["体能", "训练", "三千米"],
      importanceScore: 0.8,
      createdAt: "2026-05-06T16:00:00Z"
    }
  ],
  importantFacts: [
    {
      fact: "三千米成绩从14分提升到13分30秒",
      category: "fitness_improvement",
      confidence: 0.9,
      sourceSession: "uuid-yyy",
      createdAt: "2026-05-06T15:45:00Z"
    }
  ],
  learningProgress: {
    fitnessImprovement: true,
    studyFocus: ["医学基础", "解剖学"],
    recentConcerns: ["BMI指数", "体脂率"],
    goals: ["三千米跑进13分钟"]
  },
  interactionPatterns: {
    peakUsageHours: [19, 20, 21],
    averageSessionLength: 12, // 分钟
    favoriteDays: ["周一", "周三", "周五"]
  },
  metadata: {
    totalInteractions: 156,
    firstInteractionDate: "2026-03-02",
    lastUpdated: "2026-05-06T16:00:00Z"
  }
}
```

**偏好画像结构 (UserProfile):**
```javascript
{
  memberId: "101",
  communicationStyle: {
    formality: 0.7,           // 0-1, 正式程度
    responseLength: "medium", // short | medium | detailed
    humorLevel: 0.3,          // 0-1
    technicalDepth: 0.8,      // 0-1, 技术术语使用频率
    emojiUsage: true          // 是否使用表情符号
  },
  preferences: {
    favoriteFeatures: ["成绩分析", "雷达图", "体能趋势"],
    quickActions: ["本周评分", "BMI数据", "排名对比"],
    language: "zh-CN",
    chartPreferences: {
      defaultChartType: "radar",
      colorTheme: "purple",
      showDataLabels: true
    }
  },
  adaptationHistory: [
    {
      date: "2026-05-06",
      change: "调整为更正式的语气",
      reason: "用户多次使用专业术语",
      previousValue: 0.5,
      newValue: 0.7
    }
  ],
  privacySettings: {
    allowDataCollection: true,
    shareAnonymizedInsights: false,
    retainHistoryDuration: 90 // 天
  },
  metadata: {
    matchScore: 0.87,           // 偏好匹配度
    profileMaturity: 0.75,      // 画像成熟度
    lastAdaptedAt: "2026-05-06T16:00:00Z",
    createdAt: "2026-03-02T10:00:00Z"
  }
}
```

### 3.2 工具集设计

#### 3.2.1 工具接口规范

```javascript
class BaseTool {
  constructor(name, description, parameters, requireAuth = false) {
    this.name = name;
    this.description = description;
    this.parameters = parameters; // JSON Schema
    this.requireAuth = requireAuth; // 是否需要管理员权限
  }

  async execute(params, context) {
    throw new Error('子类必须实现execute方法');
  }

  validateParams(params) {
    // 参数验证逻辑
  }

  getSchema() {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
      requireAuth: this.requireAuth
    };
  }
}
```

#### 3.2.2 工具列表

| 工具名称 | 功能描述 | 权限要求 | 关键方法 |
|---------|---------|---------|---------|
| `query_scores` | 查询评分数据 | 无 | `getMemberScores(memberId, week)` |
| `generate_radar_chart` | 生成雷达图配置 | 无 | `getRadarConfig(scores)` |
| `trend_analysis` | 趋势分析 | 无 | `analyzeTrend(memberId, dimension)` |
| `relationship_analysis` | 关系提名分析 | 无 | `getRelationshipNominations(memberId)` |
| `mood_tracker` | 心情标签追踪 | 无 | `getMoodHistory(memberId)` |
| `social_map` | 社交地图生成 | 无 | `generateSocialMap(classId)` |
| `import_excel` | 导入Excel文件 | 无 | `parseExcelFile(fileBuffer)` |
| `export_docx` | 导出Word文档 | 无 | `generateDocx(data, template)` |
| `export_pdf` | 导出PDF文档 | 无 | `generatePdf(data)` |
| `manage_members` | 成员管理 | **管理员** | `listMembers()`, `updateMember()` |
| `class_config` | 班级配置 | **管理员** | `updateClassConfig(config)` |
| `system_settings` | 系统设置 | **管理员** | `updateSystemSettings(settings)` |

#### 3.2.3 工具执行流程

```
用户输入 → "帮我看看张东阳这周的学习成绩"
    ↓
意图识别 → { intent: "query_scores", params: { name: "张东阳", dimension: "study" } }
    ↓
任务规划 → [
  { tool: "member_lookup", params: { name: "张东阳" } },
  { tool: "query_scores", params: { memberId: "?", dimension: "study" }, dependsOn: [0] },
  { tool: "generate_radar_chart", params: { data: "?" }, dependsOn: [1] }
]
    ↓
工具执行 → 并行/串行执行工具链
    ↓
结果整合 → 自然语言回复 + 图表渲染指令
```

### 3.3 权限控制设计

#### 3.3.1 权限模型

```
┌─────────────────────────────────────────────────────────────┐
│                     权限控制系统                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  用户类型                                                    │
│  ├─ 普通成员                                                │
│  │  ├─ 可查看自己的数据                                      │
│  │  ├─ 可修改自己的信息                                      │
│  │  ├─ 可使用非管理工具                                      │
│  │  └─ 无法访问其他成员数据                                  │
│  │                                                          │
│  └─ 管理员（通过密码验证）                                   │
│     ├─ 可查看所有成员数据                                    │
│     ├─ 可修改系统配置                                        │
│     ├─ 可使用所有工具（包括管理工具）                        │
│     └─ 可查看Agent统计和使用报告                             │
│                                                             │
│  权限检查点                                                  │
│  ├─ API层：验证管理员密码                                    │
│  ├─ 工具层：检查工具的requireAuth属性                         │
│  ├─ 数据层：过滤数据访问范围                                  │
│  └─ 前端层：显示/隐藏管理员功能按钮                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### 3.3.2 权限检查中间件

```javascript
class PermissionChecker {
  
  async checkAdminPermission(password) {
    const config = getConfig();
    
    if (!config.adminPasswords || config.adminPasswords.length === 0) {
      throw new Error('管理密码未设置');
    }
    
    if (!config.adminPasswords.includes(password)) {
      throw new Error('密码错误');
    }
    
    return { success: true, isAdmin: true };
  }
  
  async checkToolAccess(toolName, userId, targetUserId) {
    const tool = ToolRegistry.getTool(toolName);
    
    if (!tool) {
      throw new Error(`工具 ${toolName} 不存在`);
    }
    
    if (tool.requireAuth) {
      const session = await this.getAdminSession(userId);
      if (!session || !session.isAdmin) {
        throw new Error('需要管理员权限才能使用此工具');
      }
    }
    
    // 数据访问权限检查
    if (this.isDataAccessTool(toolName)) {
      if (userId !== targetUserId && !await this.isAdmin(userId)) {
        throw new Error('无权查看其他成员数据');
      }
    }
    
    return { allowed: true };
  }
  
  isDataAccessTool(toolName) {
    const dataTools = ['query_scores', 'member_detail', 'academic_scores', 'fitness_scores'];
    return dataTools.includes(toolName);
  }
}
```

### 3.4 UI界面设计要点

#### 3.4.1 对话界面

- **独立滚动区域**：聊天消息区域单独滚动，不随页面整体滚动
- **消息气泡样式**：
  - 用户消息：蓝色背景，右对齐
  - AI消息：白色毛玻璃效果，左对齐
- **内嵌图表展示**：支持在消息中直接渲染ECharts图表
- **工具调用标记**：显示使用的工具名称和执行时间
- **打字动画**：AI思考时显示跳动点动画
- **快捷建议**：输入框下方显示常用问题建议按钮

#### 3.4.2 记忆管理界面

- **统计卡片**：三个卡片分别显示短期/长期/偏好记忆状态
- **风格调节滑块**：正式程度、幽默程度、技术深度等可调参数
- **常用功能展示**：显示用户最常使用的功能及使用次数
- **匹配度指示**：显示AI对用户的了解程度（百分比）

#### 3.4.3 工具箱界面

- **工具卡片布局**：每个工具一个卡片，包含图标、描述、API标识
- **权限标识**：管理员工具用红色边框和"需管理员权限"标签突出显示
- **分类颜色**：不同类别工具使用不同的主题色

---

## 4. API 接口设计

### 4.1 对话接口

#### POST /api/agent/chat

发送消息并获取AI回复（支持流式）

**请求体：**
```json
{
  "memberId": "101",
  "message": "查看我的成绩",
  "sessionId": "uuid-xxx",
  "context": {
    "currentView": "dashboard",
    "selectedMemberId": "102"
  }
}
```

**成功响应 (200):**
```json
{
  "success": true,
  "responseId": "uuid-yyy",
  "type": "mixed",
  "content": {
    "text": "这是您的成绩数据...",
    "chartConfig": { "...ECharts配置..." },
    "data": { scores: [...] },
    "toolsUsed": [
      {
        "name": "query_scores",
        "params": { "memberId": "101" },
        "executionTime": "120ms"
      }
    ]
  },
  "memoryUpdated": true,
  "suggestions": ["查看详细评分", "生成雷达图", "对比上周成绩"]
}
```

### 4.2 记忆管理接口

#### GET /api/agent/memory/:memberId

获取用户的完整记忆状态

**响应示例：**
```json
{
  "shortTerm": {
    "messageCount": 18,
    "currentTopic": "成绩查询",
    "lastInteraction": "2026-05-06T15:30:00Z"
  },
  "longTerm": {
    "totalFacts": 109,
    "summaries": [{ "date": "2026-05-05", "summary": "关注体能提升" }],
    "learningProgress": {}
  },
  "preferences": {
    "communicationStyle": {
      "formality": 0.7,
      "responseLength": "medium",
      "humorLevel": 0.3,
      "technicalDepth": 0.8
    },
    "favoriteFeatures": ["成绩分析", "雷达图"],
    "matchScore": 0.87
  }
}
```

#### PUT /api/agent/preferences/:memberId

更新用户偏好画像

**请求体：**
```json
{
  "communicationStyle": {
    "formality": 0.8,
    "responseLength": "detailed",
    "humorLevel": 0.5,
    "technicalDepth": 0.9
  },
  "favoriteFeatures": ["成绩分析"],
  "quickActions": ["本周评分", "BMI数据"]
}
```

### 4.3 管理员接口

#### POST /api/agent/admin/configure

管理员配置Agent参数

**请求体：**
```json
{
  "adminPassword": "dxys5lpo",
  "config": {
    "model": "deepseek-chat",
    "temperature": 0.7,
    "maxTokens": 2000,
    "systemPrompt": "自定义系统提示词...",
    "enabledTools": ["all"],
    "memorySettings": {
      "maxShortTermMessages": 20,
      "autoSummarizeThreshold": 10,
      "profileUpdateFrequency": 5
    }
  }
}
```

#### GET /api/agent/admin/stats

获取Agent使用统计（仅管理员）

**响应示例：**
```json
{
  "totalConversations": 1250,
  "activeUsers": 89,
  "averageSessionLength": "12分钟",
  "toolUsageStats": {
    "query_scores": 450,
    "radar_chart": 320,
    "relationship": 180,
    "export_docx": 95
  },
  "memoryStats": {
    "totalMemoriesStored": 15800,
    "averageProfileMatch": 0.82
  }
}
```

---

## 5. 数据流设计

### 5.1 完整请求处理流程

```
1. 用户在前端输入消息
        ↓
2. 前端通过 WebSocket 发送到后端
        ↓
3. 后端接收消息，开始处理：
   a. 验证用户身份（memberId + password/session）
   b. 加载用户的三级记忆
   c. 构建包含记忆上下文的系统提示词
        ↓
4. 调用 DeepSeek API：
   a. 发送用户消息 + 系统提示词 + 记忆上下文
   b. 获取 AI 回复
        ↓
5. 解析 AI 回复：
   a. 检测是否包含工具调用意图
   b. 如果有工具调用：
      - 解析工具名称和参数
      - 执行权限检查
      - 调用对应工具
      - 将工具结果返回给 AI 继续处理
   c. 如果没有工具调用：直接使用回复内容
        ↓
6. 更新记忆系统：
   a. 将本次对话存入短期记忆
   b. 提取重要信息存入长期记忆
   c. 分析用户行为更新偏好画像
        ↓
7. 构建响应：
   a. 文本内容
   b. 图表配置（如果有）
   c. 工具使用标记
   d. 建议的后续问题
        ↓
8. 通过 WebSocket 流式返回给前端
        ↓
9. 前端渲染：
   a. 显示文本回复
   b. 渲染图表（如果有的话）
   c. 显示工具调用标记
   d. 显示建议按钮
```

### 5.2 WebSocket 流式响应协议

```
客户端 → 服务端:
{ 
  type: "chat", 
  message: "查看我的成绩", 
  memberId: "101" 
}

服务端 → 客户端:

{ type: "thinking" }                          // 开始思考

{ type: "token", content: "好的" }              // 文本token流
{ type: "token", content: "，让我" }             // 继续输出
{ type: "token", content: "为您查询..." }         // 继续输出

{ type: "tool_call", tool: "query_scores" }      // 开始调用工具
{ type: "tool_result", data: {...} }             // 工具返回结果

{ type: "chart", config: {...} }                 // 图表数据

{ type: "token", content: "\n\n根据查询结果..." } // 继续输出

{ type: "done", 
  responseId: "uuid-xxx",
  memoryUpdated: true,
  suggestions: ["查看详情", "生成报告"] }      // 完成
```

---

## 6. 隐私保护机制

### 6.1 数据访问控制

| 数据类型 | 普通成员 | 管理员 |
|---------|---------|--------|
| 自己的成绩数据 | ✅ 可读可写 | ✅ 可读可写 |
| 他人的成绩数据 | ❌ 不可访问 | ✅ 可读 |
| 自己的记忆数据 | ✅ 可读可删 | ✅ 可读可删 |
| 他人的记忆数据 | ❌ 不可访问 | ⚠️ 仅统计数据 |
| 系统配置 | ❌ 不可访问 | ✅ 完全控制 |

### 6.2 敏感信息过滤

- **自动检测**：在存储到长期记忆前，过滤密码、身份证号等敏感信息
- **匿名化处理**：统计分析时使用匿名数据
- **数据保留期限**：默认保留90天，用户可自定义
- **导出权限**：用户可随时导出或删除自己的所有数据

### 6.3 记忆遗忘机制

- **短期记忆**：会话结束自动清除
- **长期记忆**：
  - 低重要性信息（confidence < 0.3）30天后自动删除
  - 中等信息（0.3 ≤ confidence < 0.7）90天后归档
  - 高重要性信息（confidence ≥ 0.7）永久保留
- **用户主动删除**：支持一键清除所有记忆数据

---

## 7. 性能优化策略

### 7.1 缓存策略

| 缓存层级 | 缓存内容 | 过期时间 | 存储位置 |
|---------|---------|---------|---------|
| L1 | 热门查询结果 | 5分钟 | 内存 |
| L2 | 用户偏好画像 | 1小时 | 内存 + 文件 |
| L3 | 工具注册表 | 启动时加载 | 内存 |
| L4 | 会话数据 | 会话周期 | 内存/Redis |

### 7.2 并发处理

- **异步IO**：所有文件操作使用异步API
- **连接池**：DeepSeek API 使用连接池
- **队列机制**：高并发时使用任务队列削峰
- **流式响应**：WebSocket流式传输，减少延迟感知

### 7.3 数据压缩

- **会话数据**：gzip压缩存储
- **长期记忆**：按月归档压缩
- **网络传输**：启用WebSocket压缩

---

## 8. 安全性考虑

### 8.1 输入验证

- 所有用户输入进行XSS过滤
- 文件上传限制大小和类型
- SQL注入防护（虽然使用JSON文件，但保持习惯）

### 8.2 API安全

- 所有API需要身份验证（memberId + session/password）
- 管理员操作需要额外密码验证
- Rate Limiting：防止滥用（每用户每分钟最多60次请求）
- CORS配置：仅允许信任的域名

### 8.3 AI安全

- **提示词注入防护**：过滤恶意指令
- **输出内容审核**：敏感内容过滤
- **工具调用限制**：危险操作需要二次确认
- **日志记录**：记录所有AI交互用于审计

---

## 9. 测试计划

### 9.1 单元测试

- [ ] 记忆系统的读写操作
- [ ] 工具的参数验证和执行
- [ ] 权限检查逻辑
- [ ] 意图分类准确性

### 9.2 集成测试

- [ ] 完整对话流程（发送→处理→响应）
- [ ] 多轮对话上下文保持
- [ ] 图表生成和渲染
- [ ] 文件导入导出

### 9.3 E2E测试

- [ ] 用户登录→对话→查看记忆→调整偏好
- [ ] 管理员登录→配置Agent→查看统计
- [ ] 并发多用户场景
- [ ] 移动端适配测试

---

## 10. 部署计划

### 10.1 开发阶段

1. **Phase 1**：核心引擎 + 记忆系统 + DeepSeek集成
2. **Phase 2**：工具集实现 + 图表生成
3. **Phase 3**：前端UI + WebSocket通信
4. **Phase 4**：权限系统 + 管理员功能
5. **Phase 5**：优化 + 测试 + 部署

### 10.2 配置项

```json
{
  "deepseek": {
    "apiKey": "your-api-key",
    "model": "deepseek-chat",
    "baseUrl": "https://api.deepseek.com/v1",
    "temperature": 0.7,
    "maxTokens": 2000
  },
  "memory": {
    "maxShortTermMessages": 20,
    "autoSummarizeThreshold": 10,
    "longTermRetentionDays": 90,
    "enableAutoLearning": true
  },
  "security": {
    "rateLimitPerMinute": 60,
    "maxFileSize": "50MB",
    "allowedFileTypes": [...]
  }
}
```

---

## 11. 风险与缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|-----|------|------|---------|
| DeepSeek API不稳定 | 功能不可用 | 中 | 实现降级方案，缓存常见回答 |
| 记忆数据过大 | 性能下降 | 中 | 定期清理、数据归档、压缩存储 |
| 用户滥用 | 成本增加 | 高 | Rate Limiting、配额管理 |
| 隐私泄露 | 法律风险 | 低 | 严格权限控制、数据加密 |
| 工具执行错误 | 用户体验差 | 中 | 完善错误处理、重试机制 |

---

## 12. 成功指标

### 12.1 功能指标

- [ ] 支持所有设计的工具调用
- [ ] 记忆系统正常工作（三级协调）
- [ ] 权限隔离有效（普通成员无法越权）
- [ ] 图表正确渲染（至少5种图表类型）
- [ ] 流式响应延迟 < 2秒

### 12.2 用户体验指标

- [ ] 用户满意度 > 85%（调研）
- [ ] 平均对话轮数 > 5轮/会话
- [ ] 记忆匹配度 > 80%
- [ ] 工具调用成功率 > 95%

### 12.3 技术指标

- [ ] API响应时间 P99 < 3秒
- [ ] 并发支持 > 100用户同时在线
- [ ] 内存占用 < 500MB
- [ ] 错误率 < 1%

---

## 附录

### A. 术语表

| 术语 | 定义 |
|------|------|
| Agent Core | AI Agent的核心引擎，负责意图识别和任务规划 |
| Memory System | 三级记忆管理系统 |
| Tool Kit | 可调用的工具集合 |
| User Profile | 用户偏好画像 |
| Session | 一次完整的对话会话 |
| Intent | 用户意图（如：查询成绩、生成图表） |

### B. 参考资源

- DeepSeek API 文档: https://platform.deepseek.com/api-docs
- ECharts 文档: https://echarts.apache.org/zh/index.html
- Socket.io 文档: https://socket.io/docs/

---

**文档版本历史：**

| 版本 | 日期 | 作者 | 变更说明 |
|------|------|------|---------|
| v1.0 | 2026-05-06 | AI Assistant | 初始设计文档 |
