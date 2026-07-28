import { describe, expect, it } from 'vitest';

import { parseNewsResult } from '../../src/ai/prompt.js';

const VALID = '{"items": [{"title": "T", "summary": "S", "sources": [{"title": "Src", "url": "https://a.com/x"}]}]}';

describe('parseNewsResult', () => {
  it('parses a fenced json block', () => {
    const items = parseNewsResult(`Here is what I found.\n\`\`\`json\n${VALID}\n\`\`\``).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('T');
  });

  it('parses a fence without a language tag', () => {
    expect(parseNewsResult(`\`\`\`\n${VALID}\n\`\`\``).items).toHaveLength(1);
  });

  it('uses the last fenced block when several exist', () => {
    const first = '```json\n{"items": [{"title": "OLD", "summary": "S", "sources": []}]}\n```';
    const second = `\`\`\`json\n${VALID}\n\`\`\``;
    const items = parseNewsResult(`${first}\nrevised:\n${second}`).items;
    expect(items[0]?.title).toBe('T');
  });

  it('falls back to a bare object when no fence is present', () => {
    expect(parseNewsResult(`Result: ${VALID}`).items).toHaveLength(1);
  });

  it('accepts an empty items list', () => {
    expect(parseNewsResult('```json\n{"items": []}\n```').items).toEqual([]);
  });

  it('throws when nothing parses', () => {
    expect(() => parseNewsResult('no json here')).toThrow(/could not parse/);
    expect(() => parseNewsResult('```json\n{"wrong": true}\n```')).toThrow(/could not parse/);
  });
});
