import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ExtractedScore {
  machineName: string | null;
  score: number | null;
  playedAt: string | null;
}

export async function extractScoreFromImage(base64Image: string, mimeType: string): Promise<ExtractedScore> {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/webp', data: base64Image },
          },
          {
            type: 'text',
            text: `This is a photo of a pinball machine score screen. Extract:
1. Machine name (the pinball machine's name, e.g. "The Munsters", "Metallica")
2. Score (the numeric score displayed)
3. Date/time if visible on screen (ISO format)

Respond ONLY with valid JSON matching this shape (use null for missing fields):
{"machineName": string|null, "score": number|null, "playedAt": string|null}`,
          },
        ],
      },
    ],
  });

  const text = message.content[0].type === 'text' ? message.content[0].text : '';
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found');
    return JSON.parse(jsonMatch[0]) as ExtractedScore;
  } catch {
    return { machineName: null, score: null, playedAt: null };
  }
}
