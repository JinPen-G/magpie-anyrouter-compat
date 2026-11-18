import assert from 'node:assert/strict';
import test from 'node:test';
import { onProvider } from '../anyrouter-compat.middleware.mjs';

const context = { protocol: 'responses', provider: { id: 'anyrouter' } };

test('applies to any conversation, including requests without a cache key', () => {
  for (const key of ['chat-one', 'chat-two', undefined]) {
    const body = {
      prompt_cache_key: key,
      input: 'Hello',
      tools: [{ type: 'namespace', name: 'example', description: '', tools: [] }],
    };
    assert.equal(onProvider(body, context), body);
    assert.equal(body.tools[0].description, 'Tools in the example namespace.');
    assert.equal(body.input, 'Hello');
  }
});

test('preserves requests for other providers and protocols', () => {
  for (const otherContext of [
    { protocol: 'responses', provider: { id: 'other' } },
    { protocol: 'chat', provider: { id: 'anyrouter' } },
    { protocol: 'responses' },
  ]) {
    const body = {
      input: [],
      tools: [{ type: 'namespace', name: 'example', description: '', tools: [] }],
    };
    const original = structuredClone(body);
    assert.equal(onProvider(body, otherContext), undefined);
    assert.deepEqual(body, original);
  }
});

test('normalizes supplied and dynamically loaded nested definitions', () => {
  const body = {
    tools: [{
      type: 'namespace',
      name: 'outer',
      description: '  ',
      tools: [{
        type: 'namespace',
        name: 'inner',
        description: '',
        tools: [{ type: 'function', name: 'inspect', defer_loading: true }],
      }],
    }],
    input: [{
      type: 'additional_tools',
      role: 'developer',
      tools: [{ type: 'function', name: 'loaded', defer_loading: false }],
    }],
  };
  onProvider(body, context);
  assert.equal(body.tools[0].description, 'Tools in the outer namespace.');
  assert.equal(body.tools[0].tools[0].description, 'Tools in the inner namespace.');
  assert.equal(body.tools[0].tools[0].tools[0].defer_loading, undefined);
  assert.equal(body.input[0].tools[0].defer_loading, undefined);
});

test('keeps parallel result groups together before loading discovered tools', () => {
  const loadedTools = [{
    type: 'namespace',
    name: 'documents',
    description: '',
    tools: [{ type: 'function', name: 'read', defer_loading: true }],
  }];
  const body = {
    tools: [{ type: 'tool_search', execution: 'client' }],
    input: [
      {
        type: 'tool_search_call',
        id: 'tsc_search',
        call_id: 'call_search',
        arguments: { query: 'read a document' },
        status: 'completed',
      },
      { type: 'function_call', call_id: 'call_regular', name: 'regular', arguments: '{}' },
      { type: 'tool_search_output', call_id: 'call_search', tools: loadedTools },
      { type: 'function_call_output', call_id: 'call_regular', output: 'finished' },
      { type: 'message', role: 'user', content: 'Continue' },
    ],
  };
  onProvider(body, context);
  assert.deepEqual(body.input.map(item => item.type), [
    'function_call', 'function_call', 'function_call_output',
    'function_call_output', 'additional_tools', 'message',
  ]);
  assert.equal(body.input[0].id, 'fc_search');
  assert.equal(body.input[0].call_id, body.input[2].call_id);
  assert.equal(body.input[0].arguments, '{"query":"read a document"}');
  assert.equal(body.input[2].output,
    'Loaded tools available for this conversation. documents.read');
  assert.equal(body.input[4].role, 'developer');
  assert.deepEqual(body.input[4].tools, loadedTools);
  assert.equal(body.input[4].tools[0].tools[0].defer_loading, undefined);
  assert.deepEqual(body.tools, [{ type: 'tool_search', execution: 'client' }]);
});

test('handles empty search results and loads a final result group', () => {
  const body = {
    input: [
      {
        type: 'tool_search_call', id: 'tsc_empty', call_id: 'call_empty',
        arguments: '{"query":"empty"}',
      },
      { type: 'tool_search_output', call_id: 'call_empty', tools: [] },
      {
        type: 'tool_search_call', id: 'tsc_found', call_id: 'call_found',
        arguments: '{}',
      },
      {
        type: 'tool_search_output', call_id: 'call_found',
        tools: [{ type: 'function', name: 'found' }],
      },
    ],
  };
  onProvider(body, context);
  assert.equal(body.input[1].output, 'Tool metadata search returned no tools.');
  assert.equal(body.input.at(-1).type, 'additional_tools');
  assert.equal(body.input.at(-1).tools[0].name, 'found');
});

test('preserves regular tools, parameters, reasoning and compaction by default', () => {
  const body = {
    model: 'gpt-example',
    stream: true,
    store: false,
    parallel_tool_calls: true,
    reasoning: { effort: 'high' },
    input: [
      { type: 'message', role: 'assistant', content: 'Previous answer' },
      { type: 'function_call', call_id: 'call_regular', name: 'regular', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_regular', output: 'finished' },
      { type: 'custom_tool_call', call_id: 'call_custom', name: 'custom', input: 'text' },
      { type: 'custom_tool_call_output', call_id: 'call_custom', output: 'finished' },
      { type: 'reasoning', id: 'rs_current', encrypted_content: 'opaque', summary: [] },
      { type: 'compaction', id: 'cmp_current', encrypted_content: 'opaque-checkpoint' },
    ],
    tools: [{ type: 'function', name: 'regular', description: 'Already described.' }],
  };
  const original = structuredClone(body);
  assert.equal(onProvider(body, context), undefined);
  assert.deepEqual(body, original);
});

test('replays only reasoning IDs explicitly configured for recovery', () => {
  const freshReasoning = {
    type: 'reasoning', id: 'rs_fresh', encrypted_content: 'fresh', summary: [],
  };
  const compaction = {
    type: 'compaction', id: 'cmp_previous', encrypted_content: 'checkpoint',
  };
  const body = {
    input: [
      {
        type: 'reasoning', id: 'rs_legacy', encrypted_content: 'legacy',
        summary: [{ type: 'summary_text', text: 'First note.' }, { type: 'summary_text', text: 'Second note.' }],
      },
      { type: 'reasoning', id: 'rs_empty', encrypted_content: 'empty', summary: [] },
      freshReasoning,
      compaction,
    ],
  };
  onProvider(body, {
    ...context,
    options: { reasoningReplayIds: ['rs_legacy', 'rs_empty'] },
  });
  assert.deepEqual(body.input, [
    {
      type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'First note.\nSecond note.' }],
    },
    freshReasoning,
    compaction,
  ]);
});

test('is idempotent and keeps valid descriptions intact', () => {
  const body = {
    tools: [{
      type: 'namespace', name: 'example', description: 'Existing description.',
      tools: [{ type: 'function', name: 'inspect', defer_loading: true }],
    }],
    input: [
      { type: 'tool_search_call', id: 'tsc_search', call_id: 'call_search', arguments: '{}' },
      { type: 'tool_search_output', call_id: 'call_search', tools: [] },
    ],
  };
  onProvider(body, context);
  const firstPass = structuredClone(body);
  assert.equal(onProvider(body, context), undefined);
  assert.deepEqual(body, firstPass);
  assert.equal(body.tools[0].description, 'Existing description.');
});
