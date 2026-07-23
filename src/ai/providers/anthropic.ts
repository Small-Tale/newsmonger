import Anthropic from '@anthropic-ai/sdk';

import { buildUserPrompt, parseNewsResult, searchingSystemPrompt } from '../prompt.js';
import type { FoundNewsItem, KnownItem, NewsProvider } from '../types.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';

/** Minimal seam over the Anthropic SDK so tests can inject a fake. */
export interface AnthropicRunner {
  run(system: string, prompt: string, model: string): Promise<string>;
}

function sdkRunner(getClient: () => Anthropic): AnthropicRunner {
  return {
    async run(system, prompt, model) {
      const stream = getClient().messages.stream({
        model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
        system,
        messages: [{ role: 'user', content: prompt }],
      });
      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') {
        throw new Error('Claude declined to research this topic');
      }
      return message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
    },
  };
}

/**
 * Anthropic-backed news provider: `claude-opus-4-8` with adaptive thinking and
 * the `web_search_20260209` server tool, so it finds genuinely new news.
 */
export function createAnthropicProvider(config: {
  model?: string;
  apiKey?: string;
  runner?: AnthropicRunner;
  hasApiKey?: () => boolean;
} = {}): NewsProvider {
  const model = config.model ?? DEFAULT_ANTHROPIC_MODEL;
  // Construct the SDK client lazily: `new Anthropic()` throws when no key is
  // set, and a provider must be constructable (for isAvailable / auto probing)
  // even without credentials.
  let client: Anthropic | undefined;
  const runner =
    config.runner ??
    sdkRunner(() => (client ??= config.apiKey !== undefined ? new Anthropic({ apiKey: config.apiKey }) : new Anthropic()));
  const hasApiKey = config.hasApiKey ?? (() => (process.env['ANTHROPIC_API_KEY'] ?? '') !== '');

  return {
    name: 'anthropic',
    model,
    isAvailable: () => Promise.resolve(hasApiKey()),
    async checkTopic(topicName: string, known: KnownItem[], sinceIso: string | null): Promise<FoundNewsItem[]> {
      const text = await runner.run(
        searchingSystemPrompt(),
        buildUserPrompt(topicName, known, sinceIso),
        model,
      );
      return parseNewsResult(text);
    },
  };
}
