const OpenAI = require('openai');

class DeepSeekClient {
  constructor(config = {}) {
    this.apiKeys = [];
    if (config.apiKeys && Array.isArray(config.apiKeys) && config.apiKeys.length > 0) {
      this.apiKeys = config.apiKeys.filter(k => k);
    } else if (config.apiKey) {
      this.apiKeys = [config.apiKey];
    } else if (process.env.DEEPSEEK_API_KEY) {
      this.apiKeys = [process.env.DEEPSEEK_API_KEY];
    }

    this.baseUrl = config.baseUrl || 'https://api.deepseek.com/v1';
    this.timeout = config.timeout || 60000;
    this.defaultModel = config.model || 'deepseek-chat';
    this.defaultTemperature = config.temperature ?? 0.7;
    this.defaultMaxTokens = config.maxTokens || 8192;
    this._clients = [];
    this._currentIndex = 0;
    this._keyErrors = {};

    for (const key of this.apiKeys) {
      try {
        this._clients.push(new OpenAI({
          apiKey: key,
          baseURL: this.baseUrl,
          timeout: this.timeout,
        }));
      } catch (e) {
        console.warn('DeepSeek client init warning:', e.message);
      }
    }

    console.log(`[DeepSeekClient] 初始化 ${this._clients.length} 个API客户端`);
  }

  get client() {
    if (this._clients.length === 0) {
      throw new Error('DeepSeek API Key 未配置');
    }
    return this._getNextClient();
  }

  _getNextClient() {
    if (this._clients.length === 1) return this._clients[0];

    const now = Date.now();
    for (let i = 0; i < this._clients.length; i++) {
      const idx = (this._currentIndex + i) % this._clients.length;
      const errInfo = this._keyErrors[idx];
      if (errInfo && now - errInfo.time < 60000) continue;
      this._currentIndex = (idx + 1) % this._clients.length;
      return this._clients[idx];
    }

    this._currentIndex = (this._currentIndex + 1) % this._clients.length;
    return this._clients[this._currentIndex];
  }

  _markKeyError(client) {
    const idx = this._clients.indexOf(client);
    if (idx >= 0) {
      this._keyErrors[idx] = { time: Date.now() };
    }
  }

  get isConfigured() {
    return this._clients.length > 0;
  }

  async chat(messages, options = {}) {
    const {
      model = this.defaultModel,
      temperature = this.defaultTemperature,
      maxTokens = this.defaultMaxTokens,
      stream = false,
      tools = [],
    } = options;

    const completionParams = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream,
    };

    if (tools.length > 0) {
      completionParams.tools = tools;
      completionParams.tool_choice = 'auto';
    }

    const maxRetries = Math.min(this._clients.length, 5);
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const currentClient = this._getNextClient();
      try {
        if (stream) {
          return await this._streamChatWithClient(currentClient, completionParams);
        }

        const response = await currentClient.chat.completions.create(completionParams);
        return {
          content: response.choices[0]?.message?.content || '',
          toolCalls: response.choices[0]?.message?.tool_calls || [],
          usage: response.usage,
          model: response.model,
        };
      } catch (error) {
        lastError = error;
        console.error(`[DeepSeekClient] API Error (attempt ${attempt + 1}/${maxRetries}):`, error.message);
        this._markKeyError(currentClient);
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    }

    throw new Error(`AI服务调用失败(重试${maxRetries}次): ${lastError?.message}`);
  }

  async *_streamChat(params) {
    const maxRetries = Math.min(this._clients.length, 5);
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const currentClient = this._getNextClient();
      try {
        const stream = await currentClient.chat.completions.create({
          ...params,
          stream: true,
        });

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;

          if (delta?.content) {
            yield { type: 'token', content: delta.content };
          }

          if (delta?.tool_calls) {
            yield { type: 'tool_call', toolCalls: delta.tool_calls };
          }
        }

        yield { type: 'done' };
        return;
      } catch (error) {
        lastError = error;
        console.error(`[DeepSeekClient] Stream Error (attempt ${attempt + 1}/${maxRetries}):`, error.message);
        this._markKeyError(currentClient);
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    }

    throw new Error(`AI流式服务调用失败(重试${maxRetries}次): ${lastError?.message}`);
  }

  async *_streamChatWithClient(client, params) {
    const stream = await client.chat.completions.create({
      ...params,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        yield { type: 'token', content: delta.content };
      }

      if (delta?.tool_calls) {
        yield { type: 'tool_call', toolCalls: delta.tool_calls };
      }
    }

    yield { type: 'done' };
  }

  async generateEmbedding(text) {
    try {
      const response = await this.client.embeddings.create({
        model: 'deepseek-embedding',
        input: text,
      });
      return response.data[0].embedding;
    } catch (error) {
      console.error('Embedding generation error:', error.message);
      return null;
    }
  }

  testConnection() {
    return this.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 5 });
  }
}

module.exports = DeepSeekClient;
