import Anthropic from '@anthropic-ai/sdk';
import { sanitizeImageDisplays, defaultBestImageIndex, type ImageRead } from './scoreRead.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-6';
const TOOL_NAME = 'record_score_read';

export interface ExtractionImage {
  base64: string;
  mimeType: string;
}

export interface ExtractedScoreReads {
  machineName: string | null;
  playedAt: string | null;
  /** One entry per input image, in input order — each lists that image's player displays. */
  reads: ImageRead[];
  bestImageIndex: number;
}

/// The model answers through a forced tool call, so its output is schema-shaped JSON rather than prose
// we'd have to regex a JSON object out of (the old approach). `strict` isn't in this SDK version's
// Tool type, hence the intersection — the API accepts it on Sonnet 4.6.
const scoreReadTool: Anthropic.Tool & { strict?: boolean } = {
  name: TOOL_NAME,
  description: 'Record every player score display visible in the photo(s).',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['machineName', 'playedAt', 'bestImageIndex', 'reads'],
    properties: {
      machineName: {
        type: ['string', 'null'],
        description: 'The pinball machine\'s title (e.g. "Black Knight 2000", "Metallica"), or null if not identifiable.',
      },
      playedAt: {
        type: ['string', 'null'],
        description: 'Date/time shown on the screen itself, ISO 8601 without a timezone, or null. Do not infer it.',
      },
      bestImageIndex: {
        type: 'integer',
        description: '0-based index of the image whose score displays are most legible.',
      },
      reads: {
        type: 'array',
        description: 'Exactly one entry per image, in the order the images were given.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['imageIndex', 'displays'],
          properties: {
            imageIndex: { type: 'integer' },
            displays: {
              type: 'array',
              description: 'One entry per PLAYER SCORE display in this image, in player order (1 first), or left-to-right, top-to-bottom when players can\'t be told. Empty if no score display is visible.',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['player', 'displayKind', 'digitWindows', 'displayText', 'template', 'lowConfidence', 'possiblyTruncated', 'truncationReason', 'leadingPositionAmbiguous'],
                properties: {
                  player: {
                    type: ['integer', 'null'],
                    description: 'Player number 1-4 from a label next to the display ("1UP", "PLAYER 1", "P1") or the machine\'s standard layout; for a single shared screen, the player it says is up. null if it cannot be told.',
                  },
                  displayKind: {
                    type: 'string',
                    enum: ['segment', 'dot_matrix', 'lcd', 'other'],
                    description: '"segment" for 7-segment / alphanumeric LED or gas-plasma digit windows; "dot_matrix" for a DMD; "lcd" for a modern LCD screen.',
                  },
                  digitWindows: {
                    type: 'integer',
                    description: 'How many digit positions this display physically has — lit or dark. Count the individual digit cells/windows and unlit segment outlines, not just the lit digits.',
                  },
                  displayText: {
                    type: 'string',
                    description: 'Transcribe the display one digit position at a time, left to right, BEFORE writing template — exactly digitWindows characters plus any commas: a fully lit digit as the digit, "?" for a partly lit digit, "_" for a dark position (including dark positions to the LEFT of the first lit digit and gaps between lit digits). Copy commas exactly where they appear. No spaces. Examples: "_4,8?_,___", "__1,234,560".',
                  },
                  template: {
                    type: 'string',
                    description: 'Score, most-significant digit first, digits 0-9 plus "?" for each position that exists but is dark/unreadable. No commas or spaces. Example: "72052??".',
                  },
                  lowConfidence: {
                    type: 'array',
                    items: { type: 'integer' },
                    description: '0-based indexes into template of FULLY-LIT digits that are hard to see for another reason (glare, blur, viewing angle). Never a partially lit segment digit — that is "?".',
                  },
                  possiblyTruncated: {
                    type: 'boolean',
                    description: 'True if the score might have more digits on the RIGHT than the template shows.',
                  },
                  truncationReason: {
                    type: ['string', 'null'],
                    description: 'Short reason when possiblyTruncated is true (e.g. "trailing comma after last lit digit"), else null.',
                  },
                  leadingPositionAmbiguous: {
                    type: 'boolean',
                    description: 'True when this is a segment display, its leftmost digit window(s) are dark, and the display shows signs of being caught mid-refresh — so the dark leading window could be a digit that happened to be unlit rather than a blank.',
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const PROMPT = `These are photos of a pinball machine's score displays, all of the same game. Read every player's score.

Which displays to read:
- Report EVERY player score display: machines for 2-4 players have one display per player, usually labelled "1UP"/"2UP"/"PLAYER 1" or numbered by position. A machine with a single shared screen (dot matrix, LCD, alphanumeric) has one display — report it once, with the player number only if the screen says whose score it is.
- Skip displays that are not player scores: ball-in-play, credits, match, bonus, timers, high-score-to-date panels.
- Skip reflections. Displays are often mirrored in the playfield glass or the cabinet's own glass — backwards (mirror-image) digits, usually dimmer, below or beside the real display. They are not additional displays.
- Skip a player display that is completely dark or blank (a player who didn't play).
- Read each display on its own. Two displays showing the same digits are still two displays.

How old displays fail in photos:
- Machines from the 1970s to early 1990s use multiplexed 7-segment LED or gas-plasma (Panaglas) displays. They light one digit (or one bank of digits) at a time, many times a second. A phone's fast shutter often catches the display mid-refresh, so some digit positions are completely dark, and a digit may be caught partially lit (some of its segments dark or dim).
- Scores are right-aligned: the ones digit is always the rightmost position. Leading positions to the left of the score are normally blank because the score is shorter — the template leaves them out. But on a display caught mid-refresh, a dark leftmost window could also be a digit that happened to be unlit; when that's possible, set leadingPositionAmbiguous.
- A dark position to the RIGHT of any lit digit is an unread digit. It exists — record it as "?". Example: a display showing "35,1" lit followed by two dark digit positions is the 5-digit score "351??".
- Count positions using the physical digit windows, visible unlit segment outlines, and the comma separators. Commas sit every three digits counting from the right, so every group AFTER a comma has exactly three positions, and the score always ends with a complete group. If the last visible comma is followed by fewer than three fully lit digits, the rest of that group still exists: e.g. lit "48," then one partly lit digit then darkness is "48???" — the partly lit digit and two dark positions make up the final group of three. A comma right after the last lit digit means three more positions follow it.
- A partly lit digit is still one position — write "?" for it, don't drop it.
- Read each display window by window. Count its physical digit windows first (the separate glass cells or segment outlines, lit or dark), then go left to right deciding for each window: every segment fully lit (the digit), only some segments lit ("?"), or dark ("_"). Keep every lit digit in the window it is actually in — don't slide digits to one end. A dark window between two lit digits is a dark digit in the middle of the score; dark windows after the last lit digit are dark digits at the end.

Rules:
- A partially lit segment digit is ambiguous, not "mostly legible": half of a 2 looks like a 7, a partial 8 looks like 0, 6 or 9, a partial 9 looks like a 4 or 7. So on segment/plasma displays, any digit whose segments are not ALL clearly and fully lit (same brightness as the fully lit digits beside it) is "?" — never your best reading of it.
- NEVER guess a digit. If you cannot see it, or it is only partly lit, use "?".
- lowConfidence is only for a digit that IS fully lit but hard to see for another reason — glare, blur, a steep viewing angle, something partly in front of it. Write your reading and put its index in lowConfidence.
- template contains only digits and "?", most-significant first, no commas or spaces.
- possiblyTruncated: true if the score may have MORE positions on the right than your template — e.g. a separator after the last lit digit you didn't account for, unlit digit windows to the right whose count you couldn't pin down, or an old segment display where the rightmost digits could be dark without a visible outline. Explain briefly in truncationReason.
- For modern dot-matrix or LCD screens, the same rules apply; those are usually complete reads.
- Also give the machine's name (from the backglass, display, or cabinet) and bestImageIndex.

Call ${TOOL_NAME} with one read per image, each listing that image's player displays.`;

/** `onRawInput` is a debugging hook (used by local test scripts) that sees the unsanitized tool input. */
export async function extractScoreReads(images: ExtractionImage[], onRawInput?: (raw: unknown) => void): Promise<ExtractedScoreReads> {
  const content: Anthropic.ContentBlockParam[] = [];
  images.forEach((img, i) => {
    if (images.length > 1) content.push({ type: 'text', text: `Image ${i}:` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/webp', data: img.base64 },
    });
  });
  content.push({ type: 'text', text: PROMPT });

  const message = await client.messages.create({
    model: MODEL,
    // Four player displays per image, up to nine images.
    max_tokens: 4096,
    // A transcription task — the same photo should read the same way every time.
    temperature: 0,
    tools: [scoreReadTool],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content }],
  });

  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === TOOL_NAME);
  onRawInput?.(toolUse?.input);
  const input = (toolUse?.input ?? {}) as {
    machineName?: unknown; playedAt?: unknown; bestImageIndex?: unknown; reads?: unknown;
  };

  const rawReads = Array.isArray(input.reads) ? (input.reads as any[]) : [];
  // Key by imageIndex where the model gave a usable one; fall back to position. Always one read per
  // input image, so downstream code can index by image.
  const reads: ImageRead[] = images.map((_, i) => {
    const raw = rawReads.find(r => r?.imageIndex === i) ?? rawReads[i] ?? {};
    return sanitizeImageDisplays(raw?.displays);
  });

  const modelBest = Number(input.bestImageIndex);
  const bestImageIndex = Number.isInteger(modelBest) && modelBest >= 0 && modelBest < images.length
    ? modelBest
    : defaultBestImageIndex(reads);

  return {
    machineName: typeof input.machineName === 'string' && input.machineName.trim() ? input.machineName.trim() : null,
    playedAt: typeof input.playedAt === 'string' ? input.playedAt : null,
    reads,
    bestImageIndex,
  };
}
