import Anthropic from '@anthropic-ai/sdk';

import { resolveApiKey } from '../api-keys.js';
import { buildUserPrompt, parseNewsResult, searchingSystemPrompt } from '../prompt.js';
import type { FoundNewsItem, KnownItem, NewsProvider } from '../types.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';

/** Minimal seam over the Anthropic SDK so tests can inject a fake. */
export interface AnthropicRunner {
  run(system: string, prompt: string, model: string): Promise<string>;
}

function sdkRunner(getApiKey: () => Promise<string | null>): AnthropicRunner {
  // Cache the client, but key it on the credential it was built with: the user
  // can change the key in Settings mid-session, and a client built with the
  // previous one would keep authenticating as the old key.
  let client: Anthropic | undefined;
  let builtWith: string | null = null;

  return {
    async run(system, prompt, model) {
      const apiKey = await getApiKey();
      if (apiKey === null) throw new Error('No Anthropic API key is configured');
      if (client === undefined || builtWith !== apiKey) {
        client = new Anthropic({ apiKey });
        builtWith = apiKey;
      }
      const stream = client.messages.stream({
        model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        // 8 searches is a digest-size choice, not a coverage one, and is
        // deliberately NOT scaled with the size of the catch-up window: what
        // bounds a useful check is how much a person will read, and that
        // doesn't grow because they were away longer. The portable version of
        // this rule lives in `searchingSystemPrompt()`, since OpenAI's hosted
        // web_search takes no equivalent cap; this stays as a cost guard.
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
  /** Resolves the key at request time; null means none is configured. */
  getApiKey?: () => Promise<string | null>;
  runner?: AnthropicRunner;
} = {}): NewsProvider {
  const model = config.model ?? DEFAULT_ANTHROPIC_MODEL;
  // One seam for "is there a key" and "what is it", so the two can't disagree.
  // Resolved per call rather than at construction, so a key saved in Settings
  // takes effect without a restart — and so constructing a provider to probe
  // its availability never needs credentials.
  const getApiKey = config.getApiKey ?? (async () => (await resolveApiKey('anthropic')).key);
  const runner = config.runner ?? sdkRunner(getApiKey);

  return {
    name: 'anthropic',
    model,
    // Metered and billed per token — safe to run on a schedule unattended.
    attended: false,
    isAvailable: async () => (await getApiKey()) !== null,
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
