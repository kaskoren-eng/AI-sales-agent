import OpenAI from 'openai';
import type { Env } from '../../config/index.js';

export class AIEngineService {
  private client: OpenAI;
  private model: string;

  constructor(env: Env) {
    this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    this.model = env.AI_MODEL;
  }

  async generateResponse(params: {
    systemPrompt: string;
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
    leadContext?: Record<string, unknown>;
  }): Promise<string> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: params.systemPrompt },
      ...params.conversationHistory.map((m) => ({ role: m.role, content: m.content })),
    ];

    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages,
    });

    return completion.choices[0]?.message.content ?? '';
  }

  async qualifyLead(params: {
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
    qualificationCriteria: string;
  }): Promise<{ qualified: boolean; score: number; reasoning: string }> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `You are a lead qualification assistant. Evaluate the conversation against these criteria: ${params.qualificationCriteria}. Respond with JSON only: { "qualified": boolean, "score": 0-100, "reasoning": "brief explanation" }`,
      },
      ...params.conversationHistory.map((m) => ({ role: m.role, content: m.content })),
    ];

    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages,
      response_format: { type: 'json_object' },
    });

    return JSON.parse(completion.choices[0]?.message.content ?? '{}');
  }
}
