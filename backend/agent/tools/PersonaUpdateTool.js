const BaseTool = require('./BaseTool');
const conversationMemory = require('../memory/ConversationMemory');

class PersonaUpdateTool extends BaseTool {
  constructor() {
    super({
      name: 'update_persona',
      description: '更新/创建你的角色风格提示词。决定你用什么样的语气、风格和用户交流。当你感觉需要调整说话方式时调用此工具。如果还没有设定过角色风格，可以主动询问用户偏好后调用此工具写入。角色提示词应该是自我描述，例如"我用简洁高效的方式和管理员交流，像一位经验丰富的参谋"或"我用温暖亲切的语气和学员对话，像一位耐心的学长"。',
      parameters: {
        persona_prompt: { type: 'string', description: '角色风格提示词，描述以什么风格交流，20-200字', required: true }
      },
      category: 'memory'
    });
  }

  async execute(params, context) {
    const memberId = context.memberId;
    if (!memberId) return { success: false, error: '无法识别用户身份' };

    const personaPrompt = params.persona_prompt;

    if (!personaPrompt || personaPrompt.trim().length < 5) {
      return { success: false, error: '角色提示词不能为空且至少5个字' };
    }

    const trimmed = personaPrompt.trim().substring(0, 300);

    await conversationMemory.setPersona(memberId, trimmed);
    await conversationMemory.flush(memberId);

    console.log(`[PersonaUpdateTool] ${memberId} 更新了角色风格: ${trimmed.substring(0, 60)}`);

    return {
      success: true,
      data: {
        type: 'persona_updated',
        persona_prompt: trimmed,
        message: '角色风格已更新。之后的对话我将按照这个风格和你交流。'
      }
    };
  }
}

module.exports = PersonaUpdateTool;
