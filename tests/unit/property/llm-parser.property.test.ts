import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CommentCategory, CommentSeverity } from "@/generated/prisma/enums";
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  parseLlmReviewResponse,
  parseTruncatedLlmReviewResponse,
} from "@/lib/llm/parser";

// Text a model might put in a message: JSON syntax, escapes, unicode, NUL.
const messageArbitrary = fc.oneof(
  fc.string({ minLength: 1, maxLength: 30 }),
  fc.string({ unit: "grapheme", minLength: 1, maxLength: 30 }),
  fc.constantFrom('a "quoted" }]', "back\\slash", "[{nested}]", "a\u0000b"),
);

const findingArbitrary = fc.record({
  filePath: fc
    .string({ minLength: 1, maxLength: 20 })
    .filter((path) => !path.includes("\u0000")),
  lineNumber: fc.integer({ min: 1, max: 2_147_483_647 }),
  category: fc
    .constantFrom(...Object.values(CommentCategory))
    .chain((value) => fc.constantFrom(value, value.toLowerCase())),
  severity: fc.constantFrom(...Object.values(CommentSeverity)),
  message: messageArbitrary,
  suggestion: fc.string({ maxLength: 30 }),
  confidence: fc.double({
    min: DEFAULT_CONFIDENCE_THRESHOLD,
    max: 1,
    noNaN: true,
  }),
});

interface Reply {
  readonly text: string;
  readonly itemEnds: readonly number[];
}

// A reply holding a JSON array of findings, possibly after some prose, with
// the offset just past each item's closing brace.
const replyArbitrary: fc.Arbitrary<Reply> = fc
  .record({
    prose: fc.constantFrom("", "Here are the findings:\n", "```json\n"),
    separator: fc.constantFrom(",", ", ", ",\n  "),
    items: fc.array(findingArbitrary, { maxLength: 5 }),
  })
  .map(({ prose, separator, items }) => {
    let text = `${prose}[`;
    const itemEnds: number[] = [];
    items.forEach((item, index) => {
      if (index > 0) text += separator;
      text += JSON.stringify(item);
      itemEnds.push(text.length);
    });
    return { text: `${text}]`, itemEnds };
  })
  .filter(({ itemEnds }) => itemEnds.length > 0);

describe("model reply parser properties", () => {
  it("never throws, whatever the reply", () => {
    const anyReply = fc.oneof(
      fc.string(),
      fc.json(),
      fc.tuple(fc.json(), fc.nat()).map(([json, cut]) => json.slice(0, cut)),
      replyArbitrary.chain(({ text }) =>
        fc.nat({ max: text.length }).map((cut) => text.slice(0, cut)),
      ),
    );
    fc.assert(
      fc.property(anyReply, (reply) => {
        expect(() => parseLlmReviewResponse(reply)).not.toThrow();
        expect(() => parseTruncatedLlmReviewResponse(reply)).not.toThrow();
      }),
    );
  });

  it("keeps exactly the findings complete before the cut", () => {
    const cutReply = replyArbitrary.chain((reply) =>
      fc.nat({ max: reply.text.length }).map((cut) => ({ ...reply, cut })),
    );
    fc.assert(
      fc.property(cutReply, ({ text, itemEnds, cut }) => {
        const full = parseLlmReviewResponse(text);
        if (!full.success) throw new Error("the whole reply must parse");
        expect(full.data).toHaveLength(itemEnds.length);

        const completeCount = itemEnds.filter((end) => end <= cut).length;
        const truncated = parseTruncatedLlmReviewResponse(text.slice(0, cut));

        if (completeCount === 0) {
          expect(truncated.success).toBe(false);
          return;
        }
        expect(truncated).toEqual({
          success: true,
          data: full.data.slice(0, completeCount),
        });
      }),
    );
  });
});
