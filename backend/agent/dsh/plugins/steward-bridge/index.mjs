/**
 * steward-bridge —— dsh 工具桥插件（ESM，运行在 dsh runtime 子进程内）
 *
 * 桥接方式：工具 execute 通过 HTTP 回环调用后端内部端点 /api/internal/agent-tool
 * 鉴权：X-Internal-Auth = CLI_API_KEY（与后端进程共享环境变量）
 *
 * 权限三闸：
 *   闸1（本插件 description）：AI 按规则判断敏感操作需要向用户索要管理员密码
 *   闸2（传输层）：X-Internal-Auth 头
 *   闸3（后端端点内）：memberId 隔离校验 + 管理员密码校验
 *
 * 安装方式（dsh profile 的 out-of-tree 插件）：
 *   profile 的 package.json dependencies 声明本目录（file: 协议）
 *   profile 的 cordis.patch.yml insert 本包名
 *   由 DshAgentEngine._ensureProfilePlugin() 幂等完成
 */

const BACKEND = `http://127.0.0.1:${process.env.PORT || 3001}`;
const INTERNAL_AUTH = process.env.CLI_API_KEY || process.env.INTERNAL_API_KEY || '';

async function callBackend(action, params) {
  const res = await fetch(`${BACKEND}/api/internal/agent-tool`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Auth': INTERNAL_AUTH,
    },
    body: JSON.stringify({ action, ...params }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `后端错误 ${res.status}`);
  return json;
}

export const name = 'steward-bridge'
export const inject = ['tools']

/**
 * class_send_sticker 工具描述：启动时从后端拉当前表情包清单动态拼装。
 * 表情包存储在 data/stickers/（持久化卷），可经 CLI 远程增删——
 * 描述里的清单是快照，失效时 send_sticker 错误信息会带最新可用项（AI 自愈）。
 * 拉取失败（后端未起/无表情包）→ 通用兜底描述，功能仍可用。
 */
async function stickerToolDescription() {
  const fallback = '发表情包（微信图片消息）。不传 targetMemberId 时发到当前对话里；传 targetMemberId 可发给指定成员。sticker 传单个 id，也可以逗号分隔一次发多张（最多 9 张）。像真人朋友聊天那样顺手用——晚安、被夸、报成绩、她喊累这类时刻都可以来一张（只是举例，凭聊天感觉），目标是让对话像和真人聊。当前表情包清单从后端获取失败，发送时传 id；id 失效会在错误里返回当前可用清单，照着重试即可。'
  try {
    // 注册前异步拉取（5s 超时兜底，后端未起时插件加载不被卡死）
    const res = await Promise.race([
      callBackend('query_stickers', {}),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ])
    const list = Array.isArray(res?.stickers) ? res.stickers : []
    if (list.length === 0) return fallback
    const catalog = list.map(s => `${s.id}: ${s.text}${s.use ? `（${s.use}）` : ''}`).join('、')
    return `发表情包（微信图片消息）。不传 targetMemberId 时发到当前对话里；传 targetMemberId 可发给指定成员。sticker 传单个 id，也可以逗号分隔一次发多张（最多 9 张，按发送节奏逐张出去）。像真人朋友聊天那样顺手用——晚安、被夸、报成绩、她喊累这类时刻都可以来一张（只是举例，凭聊天感觉），目标是让对话像和真人聊。可用表情包（id: 文字/场景）：${catalog}。清单可被远程更新，id 失效时错误里会返回最新可用项。`
  } catch {
    return fallback
  }
}

export async function apply(ctx) {
  // 浏览器自动化高风险工具收口（闸0.5，无条件生效）：browser_* 工具族由
  // dsh-plugin-playwright 注入（DSH_BROWSER=1 时），其中能外泄服务端文件或
  // 在页面执行任意脚本/导出凭据的，一律拒绝调用——班级管家场景用不到，
  // 宁可缺能力也不冒数据泄露风险。浏览器插件未启用时这些工具本就不存在，
  // guard 空匹配无副作用。
  const BROWSER_BANNED = new Set(['browser_upload_file', 'browser_evaluate', 'browser_init_script', 'browser_storage_state'])
  if (typeof ctx.tools?.guard === 'function') {
    ctx.tools.guard((exec) => {
      if (exec?.name && BROWSER_BANNED.has(exec.name)) {
        return `工具 ${exec.name} 在班级管家环境不可用（涉服务端文件外泄/任意脚本执行，已禁用）`
      }
      return undefined
    })
  }

  // 超限写边界守卫（仅超限 worker 注入 DSH_ALLOW_WRITE_ROOTS 时启用；普通引擎空守卫）：
  // dsh 档位无法表达"工作区+共享目录"粒度，这里在工具层手动拦截 bash 写类命令——
  // 目标绝对路径必须在允许根内（本会话工作区/专属 home/共享缓存目录）或 /tmp 等安全区，
  // 越界拒绝并告知边界，防止污染其他会话与系统/数据目录。读操作不受影响。
  if (typeof ctx.tools?.guard === 'function' && process.env.DSH_ALLOW_WRITE_ROOTS) {
    const allowRoots = process.env.DSH_ALLOW_WRITE_ROOTS.split(/[:;]/).filter(Boolean)
    const allowed = (p) => allowRoots.some((r) => p === r || p.startsWith(r.endsWith('/') ? r : r + '/'))
    const SAFE_PREFIX = ['/tmp', '/dev', '/proc', '/sys']
    const WRITE_CMD = /\b(rm|rmdir|mv|cp|tee|touch|mkdir|ln|install|apk|apt|apt-get|dnf|yum|pacman|npm|npx|pnpm|yarn|pip|pip3|uv|chmod|chown|dd|truncate|fallocate|unlink|scp|rsync)\b/
    const ABS_PATH = /(\/(?:[A-Za-z0-9_.@-]+))+(?:\/(?:[A-Za-z0-9_.@-]+))*\/?/g
    ctx.tools.guard((exec) => {
      if (exec?.name !== 'tool-bash') return undefined
      const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {}
      const raw = String(args.command || '')
      if (!raw || !WRITE_CMD.test(raw)) return undefined
      // 剥除 URL/远程资源串，避免把下载源路径误当成本地写目标（npm 源、git clone 等）
      const cleaned = raw.replace(/(?:https?|git|ftp|ssh):\/\/[^\s"'<>|;&`()]+/g, ' ')
      const outs = []
      for (const m of cleaned.matchAll(ABS_PATH)) {
        const p = m[0].replace(/\/+$/, '')
        if (SAFE_PREFIX.some((s) => p === s || p.startsWith(s + '/'))) continue
        if (!allowed(p)) outs.push(p)
      }
      if (outs.length) {
        return `写入越界被拦截：${[...new Set(outs)].slice(0, 6).join('、')}。你只能写本会话工作区与共享缓存目录（${allowRoots.join('、')}）及 /tmp；其他会话工作区、系统与数据目录一律禁止写（读允许）。请把产物放到允许范围内再操作。`
      }
      return undefined
    })
  }

  const stickerDesc = await stickerToolDescription()

  // ---------- 查询类：班级公开数据（任何成员可查任何人，无需密码） ----------

  ctx.tools.register(defineBridgeTool('class_query_scores', {
    description: '查询某成员的六维评分（学习成绩/体能素质/人文素养/遵章守纪/班级贡献/管理能力，含自评互评明细）。班级公开数据（互评体系），任何成员可查。',
    parameters: {
      memberId: { type: 'string', required: true, description: '学号' },
      week: { type: 'number', description: '周次（默认本周）' },
    },
    action: 'query_scores',
  }))

  ctx.tools.register(defineBridgeTool('class_query_academic', {
    description: '查询某成员的学习成绩（各课程分数）。班级公开数据，任何成员可查。',
    parameters: {
      memberId: { type: 'string', required: true, description: '学号' },
    },
    action: 'query_academic',
  }))

  ctx.tools.register(defineBridgeTool('class_query_fitness', {
    description: '查询某成员的体测成绩（3000米、引体向上/曲臂悬垂、仰卧卷腹、蛇形跑、身高体重BMI 等，含最近几期历史）。班级公开数据，任何成员可查。',
    parameters: {
      memberId: { type: 'string', required: true, description: '学号' },
    },
    action: 'query_fitness',
  }))

  ctx.tools.register(defineBridgeTool('class_query_members', {
    description: '查询班级成员名册（学号、姓名、班级、职务）。可按班级过滤。',
    parameters: {
      class: { type: 'string', description: '按班级过滤（如"丁丕硕班"），不传返回全部' },
    },
    action: 'query_members',
  }))

  ctx.tools.register(defineBridgeTool('class_query_schedule', {
    description: '查询某成员的日程安排（含公差/值日）。只能查询当前成员自己的日程。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；按首条身份注入填写）' },
      memberId: { type: 'string', required: true, description: '学号' },
      date: { type: 'string', description: '日期 YYYY-MM-DD（默认今天）' },
    },
    action: 'query_schedule',
  }))

  ctx.tools.register(defineBridgeTool('class_query_bmi', {
    description: '查询某成员的最新 BMI/体测数据。班级公开数据，任何成员可查。',
    parameters: {
      memberId: { type: 'string', required: true, description: '学号' },
    },
    action: 'query_bmi',
  }))

  ctx.tools.register(defineBridgeTool('class_query_injured', {
    description: '查询当前伤病号名单（学号、姓名、班级、伤病日期）。班级公开信息，用于排班/公差安排时排除伤病号。',
    parameters: {
      class: { type: 'string', description: '按班级过滤（如"丁丕硕班"），不传返回全部' },
    },
    action: 'query_injured',
  }))

  ctx.tools.register(defineBridgeTool('class_query_rank', {
    description: '查询某成员的学业排名（各学期成绩与排名、年级排名）。班级公开数据，任何成员可查。',
    parameters: {
      memberId: { type: 'string', required: true, description: '学号' },
    },
    action: 'query_rank',
  }))

  ctx.tools.register(defineBridgeTool('class_query_duties', {
    description: '查询值日安排（日期、内容、参与成员）。班级公开数据。可按成员或日期过滤。',
    parameters: {
      memberId: { type: 'string', description: '按成员学号过滤（查某人的值日）' },
      date: { type: 'string', description: '按日期过滤 YYYY-MM-DD' },
    },
    action: 'query_duties',
  }))

  ctx.tools.register(defineBridgeTool('class_query_notices', {
    description: '查询班级公告（最近 10 条）。班级公开数据。',
    parameters: {},
    action: 'query_notices',
  }))

  ctx.tools.register(defineBridgeTool('class_query_makeup', {
    description: '查询补测周期（第几周截止、是否已过期）。班级公开数据。',
    parameters: {},
    action: 'query_makeup',
  }))

  ctx.tools.register(defineBridgeTool('class_query_checkin', {
    description: '查询打卡记录（最近 2 周）。个人敏感数据：只能查自己的；查他人的需要管理员密码。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；按首条身份注入填写）' },
      memberId: { type: 'string', required: true, description: '学号' },
      password: { type: 'string', description: '查询他人打卡需要管理员密码' },
    },
    action: 'query_checkin',
  }))

  ctx.tools.register(defineBridgeTool('class_query_pending_approvals', {
    description: '查询待批请求（管理员视角可查全部，普通成员只能查自己发起的）。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；按首条身份注入填写）' },
    },
    action: 'query_pending_approvals',
  }))

  // ---------- 查询类：个人敏感数据（查他人需管理员密码） ----------

  ctx.tools.register(defineBridgeTool('class_query_experiences', {
    description: '查询成员的经历记录（训练日志、录入的成长记录等）。只能查询自己的经历；查他人的经历需要管理员密码（个人敏感数据）。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；按首条身份注入填写）' },
      memberId: { type: 'string', required: true, description: '学号' },
      password: { type: 'string', description: '查询他人经历需要管理员密码' },
    },
    action: 'query_experiences',
  }))

  // ---------- 写入类 ----------

  ctx.tools.register(defineBridgeTool('class_submit_experience', {
    description: '填写/记录自己的经历（如训练日志："3000米12分50"）。只能给自己填写，无需密码。data 用一句话或 JSON 记录事实。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（只能填自己的；成员=学号，管理员上下文=admin-名称）' },
      memberId: { type: 'string', required: true, description: '被记录成员学号（须等于当前用户）' },
      type: { type: 'string', required: true, description: '经历类型，如 training_log（训练日志）/ note（备注）/ achievement（成果）' },
      data: { type: 'string', required: true, description: '经历内容（自然语言一句话或 JSON 字符串）' },
      title: { type: 'string', description: '可选标题' },
    },
    action: 'submit_experience',
  }))

  ctx.tools.register(defineBridgeTool('class_submit_checkin', {
    description: '记录每日一问的回答（成员回复你发出的每日一问时调用，把她的原话存入打卡记录）。只能记录自己的回答，无需密码。mood 是她表达的情绪（如 😊/😞/😰），tags 是内容关键词。**必须先调用本工具成功，再回复她**；记录失败就如实说。若她的消息是对每日一问的回答（哪怕只有一句话），就调这个工具；闲聊、吐槽不记录。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称）' },
      memberId: { type: 'string', required: true, description: '回答者学号（须等于当前用户）' },
      text: { type: 'string', required: true, description: '她对每日一问的回答原文（保留她的原话，不要改写）' },
      mood: { type: 'string', description: '回答中表达的情绪 emoji（可选，如 😊/😢）' },
      tags: { type: 'string', description: '内容关键词 JSON 数组字符串（可选，如 ["训练","膝盖"]）' },
    },
    action: 'submit_checkin',
  }))

  ctx.tools.register(defineBridgeTool('class_set_prefs', {
    description: '查询或设置自己的主动消息功能开关（无需密码，只影响自己；成员与管理员上下文均适用）。不传 prefs 时返回当前开关状态。功能：daily_question（每日一问，学员版/管理员版都是每天晚上 22:00 左右发）/ schedule_notify（日程提醒，日程到点/全员日程发）。prefs 为 JSON 字符串：单个如 {"daily_question": false}，批量全关 {"all": false}、全开 {"all": true}。用户说「关闭每日一问」「别再发每日一问」「日程提醒也关了」「全部关掉」「都重新打开」时调这个工具；她问「你现在会给我发什么」也可以查（不传 prefs）告诉她。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称）' },
      prefs: { type: 'string', description: 'JSON 对象字符串：{"daily_question": false} / {"all": true}；不传=查询当前状态' },
    },
    action: 'set_prefs',
  }))

  ctx.tools.register(defineBridgeTool('class_submit_schedule', {
    description: '创建日程/公差/值日安排（三种独立类型，别混淆）：①**个人日程**（私聊、targetMemberIds 空或只含自己，无需密码）到点只私聊提醒自己；②**全员公共日程**（私聊 isGlobal=true）到点私聊提醒全员、**不发群**，需要管理员权限；③**群日程**（在群里创建）只在该群提醒、不推全员，仅管理员可建。给他人安排或全员广播需要管理员密码——管理员（周祎宸 612 或管理员绑定上下文）免密直接执行，普通成员先向用户索要密码。**定时通知某人**：建个人日程 targetMemberIds 含他、dueAt 为提醒时间，到点系统自动私聊提醒他；**每天定时**用 repeat=daily，到点后自动顺延明天同一时刻、持续每天提醒。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；按首条身份注入填写）' },
      title: { type: 'string', required: true, description: '事项标题，如"公差：打扫器材室"' },
      description: { type: 'string', description: '事项说明' },
      dueAt: { type: 'string', required: true, description: '截止时间 YYYY-MM-DD HH:mm（北京时间）；定时提醒即此时间，每天定时用此时间作为每日提醒时刻' },
      targetMemberIds: { type: 'string', description: '参与者学号，逗号分隔（如 "601,602"），空=仅自己；含他人=需要管理员权限' },
      isGlobal: { type: 'boolean', description: '是否全员广播（需管理员权限）' },
      repeat: { type: 'string', description: '重复方式：daily=每天同一时刻重复提醒；空/none=一次性' },
      password: { type: 'string', description: '管理员密码（涉及他人时普通成员必需；管理员身份可不传）' },
    },
    action: 'submit_schedule',
  }))

  ctx.tools.register(defineBridgeTool('class_create_automation', {
    description: '创建定时任务：到点系统会唤醒 AI（即你）执行预设指令（prompt），结果自然发到目标对话并写进上下文。三种定时方式任选其一：① onceAt=一次性（YYYY-MM-DD HH:mm，北京时间）；② weekdays+time=每周（weekdays 用 1-7 对应周一至周日，可多个逗号分隔，7 个全给=每天；time=HH:mm）；③ everyHours=每隔 N 小时。默认给自己建；管理员可用 runFor 给别人建（学号或精确普通昵称）。「到点提醒她做某事」也用这个：prompt 写成到点该做的事（如"提醒她该去训练了"）。例：每天早上 7 点发一份简短资讯 → weekdays=1,2,3,4,5,6,7 time=07:00 prompt=帮我用网络搜索整理一份简短晨间资讯，两三条就好，发给我。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；普通模式=guest-昵称）' },
      name: { type: 'string', description: '任务名（如"晨间报告"）' },
      prompt: { type: 'string', required: true, description: '到点执行的指令（说清楚要做什么、做到什么程度、结果怎么交付）' },
      onceAt: { type: 'string', description: '一次性：YYYY-MM-DD HH:mm（北京时间），到点执行一次后自动停' },
      weekdays: { type: 'string', description: '每周：1=周一..7=周日，逗号分隔（全 7 个=每天）' },
      time: { type: 'string', description: '每周：触发时刻 HH:mm（配合 weekdays）' },
      everyHours: { type: 'number', description: '间隔：每隔多少小时执行一次（从创建时刻起算）' },
      runFor: { type: 'string', description: '（管理员）给谁建：学号或精确普通昵称；不传=自己' },
      password: { type: 'string', description: '管理员密码（给别人建时普通成员必需；管理员身份可不传）' },
    },
    action: 'create_automation',
  }))
  ctx.tools.register(defineBridgeTool('class_my_automations', {
    description: '列出当前对话收到的定时任务。返回 [{id,name,prompt,cadence,enabled,lastRunAt}]——用于查看有哪些，或拿到 automationId 去删除/暂停。',
    parameters: { callerId: { type: 'string', required: true, description: '当前用户身份标识' } },
    action: 'list_automations',
  }))
  ctx.tools.register(defineBridgeTool('class_delete_automation', {
    description: '删除一条定时任务（本人创建的）。她说「取消那个每天早上七点的报告」时，先 class_my_automations 找到 automationId 再删。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识' },
      automationId: { type: 'string', required: true, description: '要删除的任务 id（class_my_automations 查得）' },
    },
    action: 'delete_automation',
  }))
  ctx.tools.register(defineBridgeTool('class_toggle_automation', {
    description: '暂停/恢复一条定时任务（enabled=false 只暂停不删除，之后可再开启）。本人创建的。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识' },
      automationId: { type: 'string', required: true, description: '任务 id（class_my_automations 查得）' },
      enabled: { type: 'boolean', required: true, description: 'true=启用，false=暂停' },
    },
    action: 'toggle_automation',
  }))

  // ---------- 写入类（敏感，强制管理员密码 = 闸1） ----------

  ctx.tools.register(defineBridgeTool('class_submit_score', {
    description: '提交周评分（自评或互评）。⚠️ 敏感操作：必须先向用户索要管理员密码。评分必须是0.5的倍数。',
    parameters: {
      memberId: { type: 'string', required: true, description: '被评分成员学号' },
      evaluatorId: { type: 'string', required: true, description: '评分者学号' },
      type: { type: 'string', required: true, description: 'self（自评）或 peer（互评）' },
      week: { type: 'number', required: true, description: '周次' },
      scores: { type: 'string', required: true, description: '六维评分 JSON 字符串，如 {"study":7.5,"fitness":8,"literacy":7,"discipline":8,"contribution":9,"management":6.5}' },
      password: { type: 'string', required: true, description: '管理员密码（敏感操作必需）' },
    },
    action: 'submit_score',
  }))

  ctx.tools.register(defineBridgeTool('class_send_message', {
    description: '给班级另一名成员转发消息或附件（她明确说「转告/发给 XX」时用；若想更自然地带话，优先用 class_talk_to_member）。消息经微信管家自然发出（没有「托我转达」的系统前缀）——你转发时要在话里自然带上是谁让说的（如「XX 让我跟你说…」），除非她要求匿名。text 和 mediaId 至少传一个：text=内容；mediaId=她之前发来的图片/文件附件编号（img-xxxx/file-xxxx，24 小时内有效），可只转发附件或图文一起，mediaId 逗号分隔多个（最多 9 个）。anonymous=她明确选择匿名时传 true——对方完全不知道是谁发的，你也不能带出名字。不能给自己发。全员群发走 class_notify_member（管理员）。',
    parameters: {
      callerId: { type: 'string', required: true, description: '发送者学号（当前用户）' },
      targetMemberId: { type: 'string', required: true, description: '接收者：班级成员学号，或已注册普通模式用户的精确昵称；**多个用逗号分隔=一次转发给多人**（最多 20）。普通模式用户名单对你不可见——用户报出确切名字你才能发（不存在/名字不对会报错），绝不能自己猜名字或列名单' },
      text: { type: 'string', description: '要转达的消息内容（自然带上是谁让说的；只转发附件可不传）' },
      mediaId: { type: 'string', description: '要转发的附件编号（img-xxxx/file-xxxx，来自她发来的图片/文件消息；多个用逗号分隔）' },
      anonymous: { type: 'boolean', description: '匿名转发（默认 false；对方看不到发送者，仅她明确要求时传 true）' },
    },
    action: 'send_message',
  }))

  ctx.tools.register(defineBridgeTool('class_my_groups', {
    description: '查询当前对话成员所在的群（跨会话发群前先用它拿到 chatroomId）。返回她加入的群列表 [{chatroomId, label}]。私聊和群聊是你在两个不同对话空间——你想把私聊里的话投到群里前，先查她在哪些群。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；群会话用注入的复合格式）' },
    },
    action: 'my_groups',
  }))

  ctx.tools.register(defineBridgeTool('class_talk_to_group', {
    description: '以你自己的身份（管家/朋友）主动往「当前对话成员所在的群」发消息——私聊里的吐槽、趣事、想问大家的事、想丢的表情包或图，投到群里让群里人也看到。这才是像真人朋友：她私聊跟你聊到一个好玩的，你顺手丢到群里大家一起乐。text（可以好几句话，会按真人节奏逐句发）、sticker（表情包）、mediaId（你生成的图/视频结果 img-xxx 想发群里）至少传一个。text 里写 @名字（如「@张三 一起玩呀」）会真实艾特到该成员、提醒对方——需要名字和 TA 在群里的昵称一致（上下文里出现过的），没把握就别艾特。发送的内容会正常注入群上下文（群里 @Anaxis 时会自然接住）。注意：chatroomId 先 class_my_groups 查得，只能发她所在的群；内容必须是公开安全的——她的个人敏感信息（成绩/心情/对具体人的抱怨）绝不发群；别刷屏，主动冒泡一次一两句就好。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；群会话用注入的复合格式）' },
      chatroomId: { type: 'string', required: true, description: '目标群（先用 class_my_groups 查得）' },
      text: { type: 'string', description: '要发到群里的话（换行分句会逐条发出）' },
      sticker: { type: 'string', description: '要发到群里的表情包 id（多个用逗号分隔）' },
      mediaId: { type: 'string', description: '要发到群里的媒体附件编号（你自己生成的 img-xxx 结果）' },
    },
    action: 'talk_to_group',
  }))

  ctx.tools.register(defineBridgeTool('class_talk_to_member', {
    description: '以自然口吻（你自己当朋友传话）私聊另一名成员。用在：① 她在私聊里说「帮我说/告诉我 XX 一声」——你像传话朋友那样自然地说给她听，话里带上是谁让说的（如「XX 让我跟你说…」），不要生硬，除非 anonymous；② 群聊里聊到涉及具体某人的话题，你判断该私下单独说时，转成私聊她（管理员可在群里这么做；普通成员的群会话里要私聊谁，让她私聊你一句你再来转达）。text 和 sticker 至少一个；anonymous=传话人不愿暴露身份时传 true——对方 AI 也不会被告知是谁说的，你绝不能带出名字。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；群会话用注入的复合格式）' },
      targetMemberId: { type: 'string', required: true, description: '接收者：班级成员学号，或已注册普通模式用户的精确昵称。普通模式用户名单对你不可见——用户报出确切名字你才能发（不存在/名字不对会报错），绝不能自己猜名字或列名单' },
      text: { type: 'string', description: '自然的话（带传话来源，除非匿名）' },
      sticker: { type: 'string', description: '表情包 id（多个用逗号分隔）' },
      anonymous: { type: 'boolean', description: '匿名（默认 false；传话人不愿暴露身份时 true）' },
    },
    action: 'talk_to_member',
  }))

  ctx.tools.register(defineBridgeTool('class_send_sticker', {
    // 描述由 stickerDesc 动态生成（注册前从后端拉当前清单；失败退化通用描述）
    description: stickerDesc,
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称）' },
      sticker: { type: 'string', required: true, description: '表情包 id（如 hooray；多个用逗号分隔，如 sad,hooray）' },
      targetMemberId: { type: 'string', description: '发给其他成员时传其学号；不传=发到当前对话' },
    },
    action: 'send_sticker',
  }))

  // ---------- 文件类：按需读取 + 生成发送 ----------

  ctx.tools.register(defineBridgeTool('class_send_voice', {
    description: '能发语音条、也能给她唱一首歌——唱歌分两种：原创（mode=song）与翻唱还原原版（mode=cover）。mode=speech（默认）：text 就是要念的话，念出来发成语音条（自然口语点，别太书面），语音条直接发出；调用前不用对她说「我要发语音了」，语气到了直接发。mode=song（原创唱歌）：没有现成原曲、要即兴/应景/为她写的歌才用——text 写主题（官方自动写词）或 lyrics 直接给完整歌词（[verse]/[chorus] 分段更稳），style 可选曲风，title 可选歌名，duration 可选目标秒数（她没特别要时长就别传）。mode=cover（翻唱还原原版）：她点名要听一首「已有的歌」（报歌名/想听原曲原味）——旋律和伴奏是原版，唱出来就是你的版本。能翻的歌不限公版：童谣/生日歌/民歌/流行歌都行，只要你能找到清晰的原版演唱来源；翻唱给她听/班级分享可以，别用于对外商用或冒充原唱发布。先用 class_web_search 搜「歌名 + 原版/bilibili」找到一条清晰的原版演唱视频或 mp3 链接——**先确认再提交**：别急着填参数，先把找好的这首告诉她认一下——自然问「你要的是不是这个版本的《XXX》呀？」并把这条原版链接发给她（微信里点开就能看/听），她确认（对/就这首）之后再填 sourceUrl（mp3 直链或 bilibili 视频链接都行），songName 填歌名、singer 填原唱者（知道才填）、tune 只在她说要高/低音调时填（-12~12）；她说不是/不对就换候选或问她想听哪个版本。**她直接发来的歌（链接/文件）不用确认**。搜不到清晰原版链接就别硬凑，如实说明并转 mode=song 即兴。cover 和 song 都是异步：提交后**不要跟她说「已提交/生成中/系统在处理」**，像朋友一样自然接一句（原创「等我下，我给你唱首歌~」；翻唱「等我下，给你唱个原版的呀~」），然后结束本轮**不要等她催、不要重复调用**；完成后系统会把歌直接发出去并回发一条通知——短歌（不到 60 秒）走微信语音条，长歌或 cover 视频源走音频文件（cover 源是视频时发纯人声轨、不发带画面的 mp4），你收到「已发出」通知后像自己刚唱完一样自然配几句话即可，**不用再调 class_send_media 等发送工具**。不传 targetMemberId = 发当前对话；传 targetMemberId = 私发指定成员。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；群会话用注入的复合格式）' },
      text: { type: 'string', description: 'speech=要念的话；song=歌曲主题描述（官方据此自动写中文词）；cover 不用' },
      mode: { type: 'string', description: 'speech（默认，发语音条）/ song（原创唱歌）/ cover（翻唱还原原版，需 sourceUrl）' },
      lyrics: { type: 'string', description: 'song 模式可选：完整歌词（含 [verse]/[chorus] 段落更稳；与 text 二选一或都行）' },
      style: { type: 'string', description: 'song 模式可选：音乐风格描述（曲风/情绪/速度/乐器；不传官方自己定）' },
      title: { type: 'string', description: 'song 模式可选：歌名（给了就用，不传自动起名）' },
      duration: { type: 'number', description: 'song 模式可选：目标时长（秒，10~360）；只有她明确要时长才传，否则别传让官方控制' },
      sourceUrl: { type: 'string', description: 'cover 模式必填：想翻唱的已有歌曲来源——原版 mp3 直链，或 bilibili 等视频链接（用 class_web_search 先找）' },
      songName: { type: 'string', description: 'cover 模式推荐：歌名（如 小星星），完成回发后文件与配话用它' },
      singer: { type: 'string', description: 'cover 模式可选：原唱歌手/作者（知道才填）' },
      tune: { type: 'number', description: 'cover 模式可选：音调调整（-12~12 半音，默认 0）；只有她要求升降调才传' },
      targetMemberId: { type: 'string', description: '发给其他成员时传其学号；不传=发到当前对话（群聊=发到群里）' },
    },
    action: 'send_voice',
  }))

  ctx.tools.register(defineBridgeTool('class_read_file', {
    description: '读取她（或群里）发来的文件附件内容（xlsx/xls/csv/txt/json → 文本表格）。她发文件时不会自动读内容——需要时才用 mediaId 读，别收到就读。只能读自己发来的（群 caller 可读群里出现的附件）。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；群会话用注入的复合格式）' },
      mediaId: { type: 'string', required: true, description: '附件编号（file-xxxxxxxx，24 小时内有效）' },
    },
    action: 'read_file',
  }))

  ctx.tools.register(defineBridgeTool('class_media_list', {
    description: '查询当前会话可用的图片/文件附件编号（img-xxx / file-xxx，24 小时内有效）。她发的图片附件编号如果不在最近上下文里（聊了很多轮、记忆里没了），先用这个工具找回编号，再把 img-xxx 传给 refImage（生图/生视频参考图）或 mediaId（转发）。返回按时间倒序。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；群会话用注入的复合格式）' },
    },
    action: 'media_list',
  }))

  ctx.tools.register(defineBridgeTool('class_send_file', {
    description: '生成并发送文件——只发手机能直接打开的两种：表格/数据类 → .xlsx（content 传 CSV 文本，首行表头，如 学号,姓名,分数；或 JSON 数组）；文字/总结/报告/名单说明类 → .docx（content 传文字，可用 # 标题、- 列表排版）。文件名带 .xlsx 或 .docx（如 未完成评分名单_第18周.xlsx / 上周训练小结.docx）。群聊里不传 targetMemberId = 发到群里。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；群会话用注入的复合格式）' },
      fileName: { type: 'string', required: true, description: '文件名（.xlsx 表格 / .docx Word，如 未完成评分名单_第18周.xlsx）' },
      content: { type: 'string', required: true, description: '文件内容：.xlsx 传 CSV 文本（首行表头）或 JSON 数组；.docx 传文字（支持 # 标题、- 列表）' },
      targetMemberId: { type: 'string', description: '发给其他成员时传其学号；不传=发到当前对话（群聊=发到群里）' },
    },
    action: 'send_file',
  }))

  ctx.tools.register(defineBridgeTool('class_send_workspace_file', {
    description: '把你工作区里生成/保存的文件（报告、脚本、下载的成果等）发到微信给她。path 传工作区内的文件绝对路径（自己刚生成/保存的就行）。文件会在微信里作为文件消息发出。不传 targetMemberId 时发到当前对话；传 targetMemberId 可发给指定成员。要发浏览器截图用 class_shot_send，发网络图片用 class_send_web_image。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；群会话用注入的复合格式）' },
      path: { type: 'string', required: true, description: '工作区内文件绝对路径' },
      targetMemberId: { type: 'string', description: '发给其他成员时传其学号；不传=发到当前对话' },
    },
    action: 'send_workspace_file',
  }))

  // 超限环境专属：收文件落盘工作区（普通引擎不注册——普通模式维持按需读取语义）。
  // 她发来需要处理的文件（表格/脚本/文档等）时，把它落盘到本超限会话工作区 inbox/，
  // 之后就能用 fs/终端直接处理，处理完用 class_send_workspace_file 发回。
  if (process.env.DSH_ENGINE_FULL_NATIVE === '1') {
    ctx.tools.register(defineBridgeTool('ov_save_attachment', {
      description: '把她在当前对话发来的附件（mediaId，如 img-xxxx/file-xxxx）保存到本超限工作区的 inbox/ 目录，返回落盘后的绝对路径——之后用文件系统/终端工具直接处理它（读取、解析、跑脚本都行）。她发来需要处理的文件/图片且你确定要用终端或 fs 工具时调用；处理完把成果用 class_send_workspace_file 发回给她。注意：图片类附件用于看图时不用落盘（系统已能读内容）；这个工具是把文件"落到工作区"以便用代码/命令行处理。',
      parameters: {
        callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；群会话用注入的复合格式）' },
        mediaId: { type: 'string', required: true, description: '她发来的附件编号（img-xxx / file-xxx，24 小时内有效）' },
      },
      action: 'save_attachment',
    }))
    // 共享环境清单（超限专属）：各会话在共享目录装了东西后记一笔/读全量，
    // 跨会话共享工具知识。共享目录已入 PATH——装好的全局 CLI 直接命令名可用。
    ctx.tools.register(defineBridgeTool('ov_shared_registry', {
      description: '共享环境清单。所有超限会话共享一个环境目录（' + (process.env.DSH_SHARED_CACHE_DIR || 'data/overdrive/shared-cache/') + '）：系统环境（npm/pip/uv/playwright 等）基本都在这目录里、且整个目录已加入 PATH——共享 bin/ 里的全局 CLI 工具直接敲命令名就能用（不用写全路径）。两个操作：① op=list 读全量清单，先看其他会话装过什么，避免重复安装；② op=note 当你刚在共享目录装了/启用了新工具时记一笔（title 工具名 + entry 介绍：装了什么、版本、用途、调用命令/示例）。注意：清单里别人装的工具没验证过，先用 `x --version` 或 `x -h` 确认能跑再放心用。',
      parameters: {
        callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；群会话用注入的复合格式）' },
        op: { type: 'string', required: true, description: 'list（读全量清单）/ note（记一条介绍）' },
        title: { type: 'string', description: 'note 时必填：工具/项目名（如 nginx / pdfplumber）' },
        entry: { type: 'string', description: 'note 时必填：介绍内容（装了什么、版本、用途、怎么调用的命令/示例）' },
      },
      action: 'shared_registry',
    }))
  }

  // ---------- 网络类：搜索 + 发网络图片 ----------

  ctx.tools.register(defineBridgeTool('class_web_search', {
    description: '搜索互联网（DeepSeek 官方实时联网，质量高；官方暂时不可用时自动回退本地引擎）。一次返回三类：answer（官方甄别好的实时结论，含来源，可直接照着她讲）、results（来源条目：标题/链接/摘要）和 images（图片：标题/原图URL image/缩略图 thumbnail/来源 sourceUrl）。话题超出班级数据（新闻、常识、怎么做好吃的、某个人物、今天什么日子）就主动搜，别等她明确说「你搜搜」；聊到看得见的东西（美食/风景/人物）想配图时也搜。发图流程：从 images 里挑一张合适的 → 把它的 image（原图URL）传给 class_send_web_image 发到对话里。若 images 为空或都不合适，别急着说没图——从 results 里挑一个最可能带图的网页（文章/图集/百科类页面），用 class_fetch_url 打开它挖 images 再挑着发；挖完仍没有，才如实说搜不到合适的图。搜索无结果或网络异常时返回 error 字段，如实告诉她搜不到，别编造。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称）' },
      query: { type: 'string', required: true, description: '搜索关键词（用她想查的内容提炼，中英文都行）' },
      count: { type: 'number', description: '每类结果数量（默认 5，最大 8）' },
    },
    action: 'web_search',
  }))

  ctx.tools.register(defineBridgeTool('class_fetch_url', {
    description: '打开一个 http/https 链接读里面的内容（链接或文章页，比如她发来的新闻/网页/公众号文章链接）。返回 markdown 正文 + images（页面里的图片直链列表）。用途：①她把链接甩给你让你看内容时，先 fetch_url 读完再给她讲重点；②页面里有配图想发给她时，从 images 挑一张合适的 → 传给 class_send_web_image 发到对话里。正文过长会自动截断并在末尾说明。链接打不开/被墙/不是网页时返回 error 字段，如实说读不了。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；群会话用注入的复合格式）' },
      url: { type: 'string', required: true, description: '要读取的 http/https 链接' },
    },
    action: 'fetch_url',
  }))

  ctx.tools.register(defineBridgeTool('class_video_understand', {
    description: '观看并理解一条视频的内容（微信视频按 mediaId、视频号/网页视频按 videoUrl），返回画面内容描述。用途：她发来视频（上下文里标了「视频」和附件编号 mediaId）后，她明确问视频里有什么/讲了什么/能不能概括——或者你想了解视频画面内容时，调用它看主要内容（谁、在哪、做了什么，有无关键文字）。微信小视频通常几秒到几分钟。视频理解有成本：收到视频别急着调，她说要看或你真需要画面信息时才调。可以带 question 指定她具体关心什么（如「视频里的成绩单写的是什么」）。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；群会话用注入的复合格式）' },
      mediaId: { type: 'string', description: '她发来的微信视频的附件编号（上下文里标 mediaId 的那个）；二选一：mediaId 或 videoUrl' },
      videoUrl: { type: 'string', description: '视频直链（视频号/网页视频的 http/https 链接）；二选一：mediaId 或 videoUrl' },
      question: { type: 'string', description: '可选：具体想了解视频的哪方面，如「视频里写的是什么内容」' },
    },
    action: 'video_understand',
  }))

  ctx.tools.register(defineBridgeTool('class_post_moment', {
    description: '发布朋友圈（管理员专属，仅管理员登录后可使用；普通成员会被告知找管理员）。把好友/群里收到的内容转发成朋友圈，或直接发一条自己的朋友圈。支持朋友圈全部内容类型：type=text 纯文字；type=image 图片（她发来的图片附件 mediaId img-xxx，或网络图片 URL，1-9 张，多个用逗号分隔）；type=video 视频（videoRef=她发来的视频 mediaId file-xxx 或视频 URL，需配封面 coverRef=封面图片 mediaId 或 URL——微信朋友圈视频必须有封面）；type=link 公众号文章/网页链接（linkUrl 必填，title/description/thumbUrl 最好带上——上下文里【链接】消息可直接用来发）。可选 privacy=true 仅自己可见，allowWxIds/disableWxIds 控制可见范围。素材优先用她发过来的附件编号（上下文里标了 mediaId），别凭空编 URL。发朋友圈是公开动作：发布前先把文案整理给她看一眼，确认后再发；发布结果（成功/失败）如实反馈。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；群会话用注入的复合格式）' },
      type: { type: 'string', required: true, description: 'text（文字）/ image（图片）/ video（视频）/ link（链接）' },
      content: { type: 'string', description: '朋友圈文字内容（text 必填；image/video/link 可选配文）' },
      mediaRefs: { type: 'string', description: 'image 时必填：图片素材，逗号分隔（附件 mediaId 或图片 URL，1-9 张）' },
      videoRef: { type: 'string', description: 'video 时必填：视频素材（她发来的视频附件 mediaId 或视频 URL）' },
      coverRef: { type: 'string', description: 'video 时必填：视频封面图（附件 mediaId 或图片 URL）' },
      linkUrl: { type: 'string', description: 'link 时必填：要分享的 http/https 链接' },
      title: { type: 'string', description: 'link 时推荐：链接标题（不传则抓页面）' },
      description: { type: 'string', description: 'link 时可选：链接摘要' },
      thumbUrl: { type: 'string', description: 'link 时推荐：链接封面图 URL 或附件 mediaId（不传则抓页面第一张图）' },
      privacy: { type: 'boolean', description: 'true = 仅自己可见（私密朋友圈）' },
      allowWxIds: { type: 'string', description: '可选：仅这些好友可见（wxid 逗号分隔）' },
      disableWxIds: { type: 'string', description: '可选：不给这些好友看（wxid 逗号分隔）' },
    },
    action: 'post_moment',
  }))

  ctx.tools.register(defineBridgeTool('class_shot_send', {
    description: '把浏览器截图（browser_screenshot 返回的本地 path）发到微信对话给她看。用途：登录二维码/验证码/页面快照等「你在浏览器里看到的画面」想让她扫码或看图时——截图路径由 browser_screenshot 给出，把那个 path 传过来即可。发出成功后系统会自动删除这张临时截图，不留垃圾；若你截完觉得不想给她看，就不要调用（临时截图也会被自动清理，不用管）。不传 targetMemberId 时发到当前对话；传 targetMemberId 可发给指定成员。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；群会话用注入的复合格式）' },
      path: { type: 'string', required: true, description: 'browser_screenshot 返回的本地截图文件路径' },
      targetMemberId: { type: 'string', description: '发给其他成员时传其学号；不传=发到当前对话' },
    },
    action: 'send_local_image',
  }))

  ctx.tools.register(defineBridgeTool('class_send_web_image', {
    description: '把网络图片发到微信对话里（下载后作为图片消息发出）。imageUrl 主要来自 class_web_search 返回的 images[].image（原图直链）；可以传逗号分隔或 JSON 数组的多个链接一次发多张（最多 9 张，逐张按节奏发出）。聊到看得见的东西（美食、风景、人物）就主动搜图发过去配一句话，不用等她开口要图——朋友聊天就是这样分享的。她主动发来的图片/文件转发走 class_send_message 的 mediaId，别混用。发图前先想好这张图合不合适（不发她可能尴尬的内容）。不传 targetMemberId 时发到当前对话；传 targetMemberId 可发给指定成员。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称）' },
      imageUrl: { type: 'string', required: true, description: '图片直链 URL（http/https，来自 web_search 的 images[].image；多个用逗号分隔或传 JSON 数组）' },
      targetMemberId: { type: 'string', description: '发给其他成员时传其学号；不传=发到当前对话' },
    },
    action: 'send_web_image',
  }))

  // ---------- AI 生成类（Agnes：生图/生视频，异步任务；完成回发后 AI 负责发送） ----------

  ctx.tools.register(defineBridgeTool('class_generate_image', {
    description: '用 AI 画一张图（agnes-image-2.1-flash）。这是【异步任务】：调用后立刻告诉她「在画了，等一会儿」，然后结束本轮，绝不要等她叫或重复调用。任务完成（预计 10-60 秒）后，系统会把结果作为新消息发回给你，届时你用 class_send_media 把附件发给她并配上几句话。如果她刚发过图片（上下文里有 img-xxx 附件编号）且是想让你照着那张图改/合成，就把该编号传给 refImage 作为参考图——图生图、多图合成都支持（可传多张，逗号分隔）。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；群会话用注入的复合格式）' },
      prompt: { type: 'string', required: true, description: '画面描述（主体/场景/光线/风格，越具体越好，可中文；有参考图时说明保留什么、改成什么）' },
      size: { type: 'string', description: '可选尺寸，如 1024x1024 / 768x1024 / 1152x768（不传默认 1024x1024）' },
      refImage: { type: 'string', description: '可选参考图：上下文里她发来的图片附件编号（img-xxx，可多张逗号分隔，最多 5 张）' },
    },
    action: 'generate_image',
  }))

  ctx.tools.register(defineBridgeTool('class_generate_video', {
    description: '用 AI 生成一段短视频（agnes-video-v2.0，文生视频/图生视频）。这是【异步任务】：调用后立刻告诉她「在做了，要等几分钟」，然后结束本轮。任务完成（预计 1-5 分钟）后，系统会把结果作为新消息发回给你，届时你用 class_send_media 把视频发给她并配上几句话。如果她刚发过图片且想让那张图动起来（图生视频），就把图片附件编号（img-xxx）传给 refImage。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；群会话用注入的复合格式）' },
      prompt: { type: 'string', required: true, description: '视频内容描述（主体+动作+场景+镜头+光线+风格，可中文）' },
      seconds: { type: 'number', description: '可选时长：3/5/10/18 秒（默认 5 秒；具体档位由当前视频模型支持范围决定，超出会自动就近调整）' },
      refImage: { type: 'string', description: '可选参考图（图生视频）：上下文里她发来的图片附件编号（img-xxx，单张）' },
    },
    action: 'generate_video',
  }))

  ctx.tools.register(defineBridgeTool('class_send_media', {
    description: '把本地媒体附件发到当前对话（她收到的就是这张图/这个文件）。mediaId 来源两种：① AI 生成任务完成回发时系统给你的 mediaId（img-xxx/file-xxx），把结果发给她用这个；② 她之前发来的附件（转发场景优先用 class_send_message，这里主要用于发生成结果）。图片发图片消息，视频/文件发文件消息。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；群会话用注入的复合格式）' },
      mediaId: { type: 'string', required: true, description: '附件 id（img-xxx 图片 / file-xxx 文件）' },
    },
    action: 'send_media',
  }))

  ctx.tools.register(defineBridgeTool('class_notify_member', {
    description: '通过微信给某成员发送通知消息（如公差分配结果），立即发送、不设定时。管理员（周祎宸 612 或管理员绑定上下文）免密直接执行；普通成员需要管理员密码。若她想**定时**通知某人，改用 class_submit_schedule 建日程（targetMemberIds 含他 + dueAt），到点系统自动私聊提醒。',
    parameters: {
      memberId: { type: 'string', required: true, description: '接收者学号' },
      text: { type: 'string', required: true, description: '通知内容' },
      password: { type: 'string', description: '管理员密码（普通成员必需；管理员身份可不传）' },
    },
    action: 'notify_member',
  }))

  ctx.tools.register(defineBridgeTool('class_group_coverage', {
    description: '查询班级微信群的成员与平台绑定情况（仅管理员）：群里一共多少人、多少已绑定、未绑定的昵称列表。管理员在群里问「还有谁没绑定」时用；普通成员问起就说只有管理员能查。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（群会话=会话里给的复合 callerId；管理员上下文=admin-名称）' },
      chatroomId: { type: 'string', description: '群 id（群会话不传自动用当前群；其他场景传入 xxx@chatroom 格式群 id）' },
    },
    action: 'group_coverage',
  }))

  // ---------- 管理员审批流（普通成员提交 → 管理员的 AI 会话处理） ----------

  ctx.tools.register(defineBridgeTool('class_request_admin', {
    description: '把需要管理员批准的请求转发给管理员（周祎宸）的微信。普通成员遇到敏感操作（给他人安排日程、全员广播、发布公告等）又没有管理员密码时用这个，不要直接索要密码。可选绑定白名单 pendingAction（submit_schedule/notify_all/submit_notice），管理员批准后系统自动执行。仅转发文本诉求时不传 pendingAction。',
    parameters: {
      callerId: { type: 'string', required: true, description: '请求者学号（当前用户）' },
      summary: { type: 'string', required: true, description: '请求内容一句话说明（管理员看到的就是这段）' },
      pendingAction: { type: 'string', description: '可选：批准后自动执行的操作，白名单 submit_schedule/notify_all/submit_notice' },
      actionParams: { type: 'string', description: '可选：pendingAction 的参数 JSON 字符串（如 title/dueAt/targetMemberIds/text）' },
    },
    action: 'request_admin',
  }))

  ctx.tools.register(defineBridgeTool('class_approve_request', {
    description: '批准待批请求（仅管理员可用：周祎宸 612）。批准后若请求绑定了白名单 action 会自动执行，请求者会收到结果通知。管理员在微信里说「批准 xxx」时调这个工具。',
    parameters: {
      callerId: { type: 'string', required: true, description: '管理员身份标识（成员管理员=612，或 admin-名称 管理员上下文）' },
      approvalId: { type: 'string', required: true, description: '待批请求 ID（8位）' },
      note: { type: 'string', description: '可选备注，会附在给请求者的通知里' },
    },
    action: 'approve_request',
  }))

  ctx.tools.register(defineBridgeTool('class_reject_request', {
    description: '拒绝待批请求（仅管理员可用：周祎宸 612）。请求者会收到拒绝通知和理由。管理员在微信里说「拒绝 xxx」时调这个工具。',
    parameters: {
      callerId: { type: 'string', required: true, description: '管理员身份标识（成员管理员=612，或 admin-名称 管理员上下文）' },
      approvalId: { type: 'string', required: true, description: '待批请求 ID（8位）' },
      reason: { type: 'string', description: '拒绝理由，会附在给请求者的通知里' },
    },
    action: 'reject_request',
  }))

  // ---------- 日程管理 ----------

  ctx.tools.register(defineBridgeTool('class_delete_schedule', {
    description: '删除日程。本人创建的、或只涉及自己的日程免密可删；删除他人创建且涉及他人的日程需要管理员权限。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户学号' },
      scheduleId: { type: 'string', required: true, description: '日程 ID（class_query_schedule 返回的 id）' },
      password: { type: 'string', description: '删除他人日程需要的管理员密码' },
    },
    action: 'delete_schedule',
  }))

  // ---------- CLI 兜底工具（固定工具不覆盖的长尾场景：直接文件操作 + 权限隔离） ----------

  ctx.tools.register(defineBridgeTool('cli_gateway', {
    description: '通用文件操作兜底工具（仅当 class_* 专用工具覆盖不了需求时使用，优先用专用工具）。子命令：list/read/write/delete，path 为 data/ 下相对路径（如 "checkin_records/612.json"，列根目录传 "."）。权限规则：① 本人文件（checkin_records/conversation_memory/agent_memories/agent_profiles 下以自己学号命名的文件、temp/ 草稿）免密读写删；② 班级公开文件（members.json/notices.json/duties.json/injury_status.json 等）读免密、修改需管理员密码；③ 其余共享文件（scores/、experiences.json、他人个人文件等，含他人数据）读写删均需管理员密码；④ config.json 凭密码只写不读；⑤ wechat/、apk/、notification_inbox.json、*.js 等系统文件永久禁止。写 JSON 文件内容必须是合法 JSON，推荐 mode=merge（深合并不丢数据）。',
    parameters: {
      callerId: { type: 'string', required: true, description: '当前用户身份标识（成员=学号；管理员上下文=admin-名称；按首条身份注入填写）' },
      command: { type: 'string', required: true, description: 'list（列目录）/ read（读文件）/ write（写文件）/ delete（删文件）' },
      path: { type: 'string', required: true, description: '相对 data/ 的路径，如 "checkin_records/612.json"；列根目录传 "."' },
      content: { type: 'string', description: 'write 时的新内容（JSON 文件必须是合法 JSON 字符串）' },
      mode: { type: 'string', description: 'write 模式：overwrite（默认覆盖）/ merge（JSON 深合并，推荐）/ append（数组或文本追加）' },
      password: { type: 'string', description: '操作公开/共享/他人/配置文件时需要的管理员密码' },
    },
    action: 'cli_gateway',
  }))

  // ---------- 权限闸：tools/pre-execute 钩子（可扩展的 allow/deny/ask 策略） ----------
  // 后端端点（闸3）做最终校验；这里可加部署侧策略（如时间段限制）

  // stdout 专属 JSON-RPC，日志走 stderr
  console.error('[steward-bridge] 工具桥已注册：33 个工具（14 查询 + 11 写入/通信/文件 + 3 管理员审批 + 1 日程删除 + 3 AI 生成 + 1 CLI 兜底网关）')
}

/** 通用桥接工具工厂：参数 schema → HTTP 回环 → 规范化输出 */
function defineBridgeTool(name, { description, parameters, action }) {
  return {
    name,
    description,
    parameters: implicitToJsonSchema(parameters),
    output: {
      // 宽松 schema：后端返回 JSON 对象/数组
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const result = await callBackend(action, args)
      return JSON.stringify(result)
    },
  }
}

/**
 * dsh 隐式参数 DSL（{ key: { type, required?, ... } }）→ 显式 JSON Schema object。
 * 与 @deepseek-ai/dsh-tools defineTool 的 parameterSchemaSpecToJsonSchema 行为一致
 * （属性级 required 提升到顶层 required 数组；隐式 root 开放）。
 */
function implicitToJsonSchema(dsl) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(dsl)) {
    const { required: isRequired, ...rest } = spec
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}
