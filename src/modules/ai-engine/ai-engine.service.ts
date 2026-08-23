import OpenAI from 'openai';
import type { Env } from '../../config/index.js';
import { AppError } from '../../shared/errors.js';

export class AIEngineService {
  private openai: OpenAI | null = null;
  private model: string;

  constructor(private env: Env) {
    this.model = env.AI_MODEL;
  }

  /**
   * Built on first use — `new OpenAI({ apiKey: undefined })` throws from inside the vendor's
   * constructor, and `OPENAI_API_KEY` is optional in env.ts. The one caller today
   * (`message-processor.worker.ts`) already checks the key before constructing this, so nothing
   * is broken; the laziness is here so the NEXT caller cannot reintroduce a boot crash by
   * forgetting that check. Same treatment as `CallAnalysisService` and `EmailService`.
   */
  private get client(): OpenAI {
    if (!this.env.OPENAI_API_KEY) {
      throw new AppError(
        'AI replies are unavailable: OPENAI_API_KEY is not configured.',
        503,
        'OPENAI_NOT_CONFIGURED',
      );
    }
    this.openai ??= new OpenAI({ apiKey: this.env.OPENAI_API_KEY });
    return this.openai;
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
