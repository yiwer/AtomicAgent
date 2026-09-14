// One vocabulary for measured consumption, shared by the task detail and the quota panel so both read the same facts.
export const basisText = { 'sdk-estimate': '引擎估算', 'provider-confirmed': '供应商确认', 'platform-observed': '平台观测' };
export const unitText = { input_tokens: '输入 token', output_tokens: '输出 token', cache_read_input_tokens: '缓存读取 token',
 cache_creation_input_tokens: '缓存写入 token', web_search_requests: '网页检索次数', estimated_cost_micro_usd: '估算成本（微美元）',
 calls: '调用次数', request_bytes: '请求字节', response_bytes: '响应字节', source_bytes: '来源字节' };
export const scopeText = { 'agent-main': '主执行', auxiliary: '辅助调用', transport: '连接探测', 'registered-readonly': '登记只读 MCP' };
export const invocationStatusText = { requested: '已请求', admitted: '已准入', started: '已开始', completed: '已完成', failed: '失败', denied: '已拒绝', unknown: '未知' };
export const kindText = { model: '模型', tool: '工具', mcp: '只读 MCP', transport: '连接探测' };
const completenessText = { complete: '完整', partial: '部分', unknown: '未知' };
const freshnessText = { fresh: '新鲜', stale: '已过期', 'final-recorded-observation': '终态最终观测', 'recorded-projection': '记录投影', unknown: '未知' };
export const usageValue = total => total.value === null ? '未知（未计量，不记为 0）' : String(total.value);

export function renderUsageTotals(container, totals) {
 container.replaceChildren();
 if (!totals.length) { container.textContent = '尚无用量观测。未计量不等于零消费。'; return; }
 for (const total of totals) {
  const row = document.createElement('p');
  row.textContent = `${basisText[total.basis] ?? total.basis} · ${unitText[total.unit] ?? total.unit} · ${usageValue(total)}` +
   ` · 供应商 ${total.provider} · 范围 ${scopeText[total.scope] ?? total.scope}` +
   ` · 完整度 ${completenessText[total.completeness] ?? total.completeness}（未知序列 ${total.unknown_series}/${total.series}，观测 ${total.observations} 条）` +
   ` · ${total.in_flight ? '含在途计量' : '无在途计量'} · 观测 ${total.observed_at ?? '尚无'} · 来源 ${total.sources.join('、')}`;
  container.append(row);
 }
}
export const usageFreshness = usage =>
 `来源 ${usage.source} · 读取 ${usage.queried_at} · 观测 ${usage.observed_at ?? '尚无'} · 新鲜度 ${freshnessText[usage.freshness] ?? usage.freshness} · 覆盖 ${usage.coverage}`;
