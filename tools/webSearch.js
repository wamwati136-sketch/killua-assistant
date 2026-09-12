/**
 * tools/webSearch.js
 * Level 1 (SAFE) — read-only network fetch.
 *
 * Uses DuckDuckGo's free Instant Answer API (no key required). It is
 * intentionally lightweight — for production-grade results, swap this
 * out for a paid provider (Tavily, Serper, Bing Search, etc.) by
 * replacing the fetch call below; the tool `definition` and return
 * shape can stay the same so nothing else needs to change.
 */

const fetch = require('node-fetch');

const definition = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the web for current information, facts, or topics not in your training data. Returns a short summary plus a few related links.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query.',
        },
      },
      required: ['query'],
    },
  },
};

async function execute(args) {
  const query = args.query;

  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Search request failed (${res.status})`);
    const data = await res.json();

    const relatedTopics = (data.RelatedTopics || [])
      .flatMap((t) => (t.Topics ? t.Topics : [t]))
      .filter((t) => t.Text)
      .slice(0, 5)
      .map((t) => ({ text: t.Text, url: t.FirstURL }));

    const hasAnswer = Boolean(data.AbstractText || data.Answer || relatedTopics.length);

    if (!hasAnswer) {
      return {
        ok: true,
        query,
        summary: 'No direct instant answer found for this query.',
        results: [],
      };
    }

    return {
      ok: true,
      query,
      summary: data.Answer || data.AbstractText || null,
      source: data.AbstractSource || null,
      source_url: data.AbstractURL || null,
      results: relatedTopics,
    };
  } catch (err) {
    return { ok: false, query, error: err.message };
  }
}

module.exports = {
  level: 1,
  definition,
  execute,
  softConfirm: false,
};
