import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Env } from '../../config/index.js';

export class AIEngineService {
  private genAI: GoogleGenerativeAI;
  private model: string;

  constructor(env: Env) {
    this.genAI = new GoogleGenerativeAI(env.GOOGLE_AI_API_KEY!);
    this.model = env.AI_MODEL;
  }

  async generateResponse(params: {
    systemPrompt: string;
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
    leadContext?: Record<string, unknown>;
  }): Promise<string> {
    const model = this.genAI.getGenerativeModel({
      model: this.model,
      systemInstruction: params.systemPrompt,
    });

    const chat = model.startChat({
      history: params.conversationHistory.slice(0, -1).map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
    });

    const lastMessage = params.conversationHistory.at(-1);
    const result = await chat.sendMessage(lastMessage?.content ?? '');
    return result.response.text();
  }

  async qualifyLead(params: {
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
    qualificationCriteria: string;
  }): Promise<{ qualified: boolean; score: number; reasoning: string }> {
    const model = this.genAI.getGenerativeModel({
      model: this.model,
      systemInstruction: `You are a lead qualification assistant. Evaluate the conversation against these criteria: ${params.qualificationCriteria}. Respond with JSON only: { "qualified": boolean, "score": 0-100, "reasoning": "brief explanation" }`,
      generationConfig: { responseMimeType: 'application/json' },
    });

    const chat = model.startChat({
      history: params.conversationHistory.slice(0, -1).map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
    });

    const lastMessage = params.conversationHistory.at(-1);
    const result = await chat.sendMessage(lastMessage?.content ?? '');
    return JSON.parse(result.response.text());
  }
}
