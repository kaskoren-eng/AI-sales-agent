import OpenAI, { toFile } from 'openai';
import type { Env } from '../../config/env.js';
import type { TranscriptSegment, SalesCallAnalysis } from '../../db/schema/call-learnings.js';

const ANALYSIS_PROMPT = `You are a sales call coach analyzing a recorded sales conversation.
Extract structured learnings to help an AI sales agent perform better on future calls.

Respond with a JSON object (all fields optional, omit what cannot be determined):
{
  "opening_technique": "how the opener established rapport or interest",
  "pain_points_uncovered": ["list of customer pain points discovered"],
  "objections": [{ "objection": "what they said", "response": "how it was handled", "handled_well": true }],
  "closing_technique": "what closing approach was used",
  "rapport_building": "key rapport-building moments",
  "key_questions_asked": ["effective questions that generated real insights"],
  "what_worked": ["specific techniques or phrases that moved the sale forward"],
  "what_didnt_work": ["approaches that caused friction or stalls"],
  "overall_effectiveness_score": 75,
  "recommendations": ["concrete, actionable advice the AI agent should follow on future calls"]
}

Be specific and concrete — generalizations are not useful. Focus on repeatable patterns.`;

export class CallAnalysisService {
  private openai: OpenAI;
  private model: string;

  constructor(private env: Env) {
    this.openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    this.model = env.AI_MODEL;
  }

  async downloadAndTranscribe(recordingUrl: string): Promise<TranscriptSegment[]> {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = this.env;

    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const audioRes = await fetch(`${recordingUrl}.mp3`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(90_000),
    });

    if (!audioRes.ok) {
      throw new Error(`Twilio recording download failed: HTTP ${audioRes.status}`);
    }

    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    const file = await toFile(audioBuffer, 'recording.mp3', { type: 'audio/mpeg' });

    const transcription = await this.openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'verbose_json',
    });

    const segments = (transcription as unknown as { segments?: Array<{ text: string; start: number; end: number }> }).segments;

    if (!segments?.length) {
      return [{ speaker: 'unknown', text: (transcription as unknown as { text: string }).text }];
    }

    return segments.map((seg) => ({
      speaker: 'unknown',
      text: seg.text.trim(),
      start: seg.start,
      end: seg.end,
    }));
  }

  async analyzeTranscript(transcript: TranscriptSegment[]): Promise<SalesCallAnalysis> {
    const text = transcript
      .map((s) => (s.start != null ? `[${s.start.toFixed(1)}s] ${s.text}` : s.text))
      .join('\n');

    const completion = await this.openai.chat.completions.create({
      model: this.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: ANALYSIS_PROMPT },
        { role: 'user', content: `Transcript:\n\n${text}` },
      ],
    });

    try {
      return JSON.parse(completion.choices[0]?.message.content ?? '{}') as SalesCallAnalysis;
    } catch {
      return {};
    }
  }

  static formatLearningsForPrompt(
    learnings: Array<{ analysis: SalesCallAnalysis | null; outcome: string | null }>,
  ): string {
    if (!learnings.length) return '';

    const items = learnings
      .map((l, i) => {
        const a = l.analysis ?? {};
        const lines: string[] = [`[Call ${i + 1}${l.outcome ? ` — ${l.outcome}` : ''}]`];
        if (a.what_worked?.length) lines.push(`• Works: ${a.what_worked.join('; ')}`);
        if (a.objections?.length) {
          const good = a.objections.filter((o) => o.handled_well).map((o) => o.objection);
          if (good.length) lines.push(`• Objections handled well: ${good.join('; ')}`);
        }
        if (a.pain_points_uncovered?.length) lines.push(`• Pain points: ${a.pain_points_uncovered.join('; ')}`);
        if (a.recommendations?.length) lines.push(`• Apply: ${a.recommendations.join('; ')}`);
        return lines.join('\n');
      })
      .join('\n\n');

    return `\n\n---\nLEARNINGS FROM RECENT REAL SALES CALLS (apply these patterns):\n${items}\n---`;
  }
}
