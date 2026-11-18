// AnyRouter Responses 请求的工具定义与历史工具检索兼容入口。
// reasoningReplayIds 可指定已核定需要回放摘要的旧推理记录。
export function onProvider(body, ctx) {
  if (ctx.protocol !== 'responses' || ctx.provider?.id !== 'anyrouter') return;
  const legacyReasoningIds = new Set(
    Array.isArray(ctx.options?.reasoningReplayIds) ? ctx.options.reasoningReplayIds : [],
  );

  const definitionGroups = [];
  if (Array.isArray(body.tools)) definitionGroups.push(body.tools);
  const inputItems = Array.isArray(body.input) ? body.input : [];
  for (const item of inputItems) {
    if (['additional_tools', 'tool_search_output'].includes(item.type)
        && Array.isArray(item.tools)) {
      definitionGroups.push(item.tools);
    }
  }

  let descriptionsFilled = 0;
  let deferredFlagsRemoved = 0;
  for (const definitions of definitionGroups) {
    for (const tool of definitions) {
      if (tool.type === 'namespace') {
        if (typeof tool.description !== 'string' || tool.description.trim() === '') {
          tool.description = 'Tools in the ' + tool.name + ' namespace.';
          descriptionsFilled += 1;
        }
        if (Array.isArray(tool.tools)) definitionGroups.push(tool.tools);
      }
      // 请求已携带完整定义，去掉路由不支持的延迟加载标记。
      if (Object.prototype.hasOwnProperty.call(tool, 'defer_loading')) {
        delete tool.defer_loading;
        deferredFlagsRemoved += 1;
      }
    }
  }

  // 路由接受当前搜索工具声明，但拒绝历史里的原生搜索调用及结果。
  // 保留 call_id 的配对，将历史交换映射为普通函数调用并显式加载所得工具。
  const compatibleItems = [];
  let pendingTools = [];
  let searchesConverted = 0;
  let legacyReasoningReplayed = 0;
  function flushLoadedTools() {
    if (pendingTools.length === 0) return;
    compatibleItems.push({
      type: 'additional_tools',
      role: 'developer',
      tools: pendingTools,
    });
    pendingTools = [];
  }

  for (const item of inputItems) {
    if (!['function_call_output', 'custom_tool_call_output', 'tool_search_output']
        .includes(item.type)) {
      flushLoadedTools();
    }
    // 明确指定的旧推理记录沿用原有可读摘要回放上下文。
    if (item.type === 'reasoning' && legacyReasoningIds.has(item.id)) {
      const summaries = Array.isArray(item.summary) ? item.summary : [];
      const text = summaries.map(block => block.text).filter(Boolean).join('\n');
      if (text) {
        compatibleItems.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      }
      legacyReasoningReplayed += 1;
      continue;
    }
    if (item.type === 'tool_search_call') {
      // 普通函数的 item id 采用 fc_ 前缀，原 call_id 继续对应原结果。
      const id = typeof item.id === 'string' && item.id.startsWith('tsc_')
        ? 'fc_' + item.id.slice(4)
        : item.id;
      compatibleItems.push({
        type: 'function_call',
        id,
        call_id: item.call_id,
        name: 'tool_search',
        arguments: typeof item.arguments === 'string'
          ? item.arguments
          : JSON.stringify(item.arguments),
        status: item.status,
      });
      searchesConverted += 1;
      continue;
    }
    if (item.type === 'tool_search_output') {
      const tools = Array.isArray(item.tools) ? item.tools : [];
      const names = [];
      for (const tool of tools) {
        if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
          for (const nested of tool.tools) names.push(tool.name + '.' + nested.name);
        } else if (tool.name) {
          names.push(tool.name);
        }
      }
      compatibleItems.push({
        type: 'function_call_output',
        call_id: item.call_id,
        output: names.length > 0
          ? 'Loaded tools available for this conversation. ' + names.join(', ')
          : 'Tool metadata search returned no tools.',
      });
      // 等同一组调用的结果全部结束后再加载，避免插入并行调用配对之间。
      pendingTools.push(...tools);
      searchesConverted += 1;
      continue;
    }
    compatibleItems.push(item);
  }
  flushLoadedTools();
  if (searchesConverted > 0 || legacyReasoningReplayed > 0) body.input = compatibleItems;

  if (descriptionsFilled === 0 && deferredFlagsRemoved === 0
      && searchesConverted === 0 && legacyReasoningReplayed === 0) return;
  console.info('anyrouter-compat', 'namespaces=' + descriptionsFilled,
    'deferred=' + deferredFlagsRemoved, 'search=' + searchesConverted,
    'legacy_reasoning=' + legacyReasoningReplayed);
  return body;
}
