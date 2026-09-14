import { configurationPanel } from './configurations.js';
import { observeRun } from './events.js';
const $ = id => document.getElementById(id);
const statusText = { queued: '排队中', running: '运行中', succeeded: '成功', failed: '失败', cancelled: '已取消', timed_out: '已超期', pending: '待回收', complete: '已核验回收', unknown: '未知', preparing: '准备环境', executing: '执行中', terminal: '终态' };
const errorText = { file_expired: '源文件已过期，请选择仍有效的产物。', file_incomplete: '源文件内容不完整，未接纳新任务。请选择其他产物。', input_contract_incompatible: '此产物不符合当前 CSV / 行数组 JSON 统计契约。', file_not_found: '源文件不存在或当前身份无权访问，请重新选择。', configuration_identity_changed: '登录身份已变化；请登录原身份找回配置操作。', configuration_conflict: '配置已被其他操作更新。请打开最新修订并重新预览。', configuration_preview_required: '请重新预览当前配置后再发布。', binding_not_allowed: '所选配置超过服务端登记的允许范围。', configuration_command_conflict: '此操作标识已绑定其他内容，请保留原操作材料核对。', authentication_required: '登录已失效，请重新登录。', forbidden: '当前身份无权执行此操作。', submission_identity_changed: '登录身份已变化，请重新登录原身份后找回提交。', config_unavailable: '登记配置不可用。', idempotency_conflict: '原提交标识已绑定其他内容；已保留恢复材料，请核对原提交。', service_unavailable: '服务暂不可用，请稍后点击刷新重试。', invalid_request: '请检查提示词与提交内容。' };
let me = null, selected = null, loading = false, pending = null, selectedInput = null;
let observation = null;
const configurations = configurationPanel({ api, identity: () => me });
function stopObservation() { observation?.stop(); observation = null; }
function ensureObservation(id, identity) {
  if (observation?.id === id && observation.identity === identity) return;
  stopObservation(); $('event-progress').textContent = '等待进度事件；业务状态以任务查询为准';
  const active = () => me === identity && selected === id;
  observation = { id, identity, stop: observeRun({ id, identity,
    onChange: async () => { if (active()) await renderDetail(id); },
    onUnauthorized: () => { if (active()) loggedOut(); },
    onStatus: text => { if (active()) $('event-status').textContent = text; },
    onProgress: text => { if (active()) $('event-progress').textContent = text; },
  }) };
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 || ['submission_identity_changed', 'configuration_identity_changed', 'cancellation_identity_changed'].includes(data.error)) loggedOut();
    throw Object.assign(new Error(errorText[data.error] ?? `请求失败：${data.error ?? response.status}`), { submissionStatus: data.submission_status, commandStatus: data.command_status });
  }
  return data;
}
function showError(error) { $('error').textContent = error instanceof Error ? error.message : '连接失败，请重试。'; $('error').hidden = false; }
const pendingStorageKey = identity => `atomicagent.pending:${JSON.stringify([identity.workspace, identity.actor])}`;
function renderPending() {
  $('pending-submission').hidden = !pending;
  $('submit').disabled = !!pending;
}
async function submitPending() {
  const identity = me, submission = pending;
  if (!identity || !submission) return;
  $('recover-submission').disabled = true;
  try {
    const run = await api('/v1/runs', { method: 'POST', headers: { 'Idempotency-Key': submission.key,
      'X-Submission-Actor': identity.actor, 'X-Submission-Workspace': identity.workspace }, body: submission.body });
    sessionStorage.removeItem(pendingStorageKey(identity));
    if (me !== identity) return;
    pending = null; selected = run.run_id; location.hash = run.run_id; await refresh();
  } catch (error) {
    // A permission denial cannot prove that an earlier submission was not accepted.
    if (error.submissionStatus === 'not_accepted') {
      sessionStorage.removeItem(pendingStorageKey(identity));
      if (me === identity) pending = null;
    }
    showError(error);
  } finally { $('recover-submission').disabled = false; renderPending(); }
}
function loggedOut() {
  configurations.logout();
  stopObservation();
  me = null; selected = null; selectedInput = null; pending = null; $('input-file').value = ''; $('input-status').textContent = '未绑定文件 · 提交提示词任务'; $('workspace').hidden = true; $('login').hidden = false;
  $('logout').hidden = true; $('refresh').hidden = true; $('identity').textContent = '未登录'; $('nav-workspace').textContent = '尚未登录';
  $('runs').replaceChildren(); $('result').textContent = ''; $('manifest').textContent = ''; $('skill-evidence').replaceChildren(); $('mcp-evidence').textContent = ''; $('input-bindings').replaceChildren(); $('artifacts').replaceChildren(); $('detail').close();
  renderPending();
}
function node(tag, text, className) { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; }
function pill(state) { return node('span', statusText[state] ?? state, `pill ${state}`); }
function fact(label, value) { $('facts').append(node('dt', label), node('dd', value ?? '—')); }
async function renderDetail(id, open = false) {
  const identity = me;
  const run = await api(`/v1/runs/${id}`);
  const result = run.status === 'succeeded' ? await api(`/v1/runs/${id}/result`) : null;
  if (me !== identity || selected !== id) return;
  $('detail-id').textContent = id; $('facts').replaceChildren();
  fact('业务状态', statusText[run.status]); fact('阶段', statusText[run.phase]); fact('失败类别', run.failure);
  fact('回收状态', statusText[run.cleanup.status]); fact('最近核验', run.cleanup.observed_at);
  fact('核验来源', run.cleanup.source); fact('输出校验', run.validation?.status === 'passed' ? `通过 ${run.validation.contract}` : run.validation?.status === 'failed' ? '不合格' : '未完成');
  fact('Attempt', run.attempt_id);
  const stopText = { pending: '待核验', unknown: '未知', stopped: '已核验停止', not_started: '未启动 Attempt' };
  $('cancel-facts').textContent = run.cancellation ? `取消裁定：${run.cancellation.decision === 'accepted' ? '已接受' : '已到终态，取消未改变结果'} · 请求 ${run.cancellation.operation_id} · ${run.cancellation.requested_at} · 发起者 ${run.cancellation.actor} · 实际停止：${stopText[run.stop?.status] ?? '无取消停止观测'} · 宽限截止 ${run.cancellation.grace_deadline_at ?? '不适用'} · 强停意图 ${run.stop?.forced_at ?? '无'} · 核验 ${run.stop?.observed_at ?? '尚无'} · 来源 ${run.stop?.source ?? '未知'} · 独立回收：${statusText[run.cleanup.status]}` : '尚未请求取消。取消接受后仍需核验实际停止和独立回收。执行中取消有 30 秒宽限。';
  $('cancel-run').textContent = run.cancellation ? '核对取消请求' : '取消任务';
  $('cancel-run').hidden = !!run.terminal_at && !run.cancellation;
  $('result').textContent = result ? JSON.stringify(result.result, null, 2) : '尚无已提交结果';
  $('input-bindings').replaceChildren();
  for (const binding of run.inputs) {
    const section = node('section', '', 'input-binding');
    section.append(node('p', `InputBinding ${binding.binding_id ?? '历史记录'} · ${binding.path}`));
    section.append(node('p', binding.source ? `来源 Artifact ${binding.source.artifact_id} · 原 Run ${binding.source.run_id} · 原期限 ${binding.source.expires_at}` : `来源上传文件 ${binding.file_id}`));
    section.append(node('p', `固定摘要 ${binding.sha256} · ${binding.size_bytes} bytes`));
    section.append(node('p', `独立副本 · Run ${binding.copy.run_id} · ${binding.copy.path} · ${binding.copy.status === 'removed' ? '已核验回收' : binding.copy.status === 'loaded' ? '已确认装载' : '尚未确认'} · 装载时间 ${binding.copy.loaded_at ?? '无'} · 回收 ${statusText[binding.copy.cleanup_status]} · ${binding.copy.observed_at ?? '尚无观测'}`));
    $('input-bindings').append(section);
  }
  if (!run.inputs.length) $('input-bindings').textContent = '此任务没有文件输入';
  $('mcp-evidence').textContent = JSON.stringify(run.mcp ?? [], null, 2);
  $('boundary-summary').textContent = run.boundary ? `隔离：${run.boundary.isolation} · 审计覆盖：partial（受控模型与工具；未观察全部系统调用） · ${run.boundary.observed_at}` : '未知：尚无真实隔离观测。确定性演示不证明隔离。';
  $('boundary-evidence').textContent = run.boundary ? JSON.stringify(run.boundary, null, 2) : '无执行边界证据';
  if (run.execution.output_contract === 'research-report@1') fact('研究检查范围', '格式与引用检查通过不代表结论正确；结论语义未核验。');
  $('skill-evidence').replaceChildren();
  const state = value => value === null ? '未知' : value ? '是' : '否';
  for (const e of run.skills ?? []) { const row = document.createElement('p'); row.textContent = `${e.id}@${e.version} · 已请求 ${state(e.requested)} · 文件已装载 ${state(e.materialized)} · 引擎已加载 ${state(e.loaded)} · 可调用 ${state(e.callable)} · 实际使用 ${state(e.used)} · ${e.source} · ${JSON.stringify(e.evidence_sources ?? {})} · ${e.observed_at ?? '尚无观测'} · 调用 ${e.invocation_id ?? '无'} · Attempt ${e.attempt_id ?? '尚未开始'}`; $('skill-evidence').append(row); }
  $('manifest').textContent = JSON.stringify({ ...run.execution, inputs: run.inputs }, null, 2);
  $('artifacts').replaceChildren(); $('artifact-error').textContent = '';
  for (const artifact of result?.artifacts ?? []) {
    const row = node('p', `${artifact.path} · ${artifact.size_bytes} bytes · ${artifact.availability === 'expired' ? '已过期' : '可下载'} · 保留至 ${new Date(artifact.expires_at).toLocaleString('zh-CN')} `);
    const button = node('button', `下载 ${artifact.path}`); button.disabled = artifact.availability !== 'available';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const link = await api(`/v1/artifacts/${artifact.artifact_id}/download-link`, { method: 'POST', body: '{}' });
        const anchor = document.createElement('a'); anchor.href = link.url; anchor.download = artifact.path.split('/').pop(); anchor.rel = 'noreferrer'; anchor.click();
      } catch (error) { $('artifact-error').textContent = error.message; }
      finally { button.disabled = false; }
    });
    row.append(button);
    if (['csv', 'json'].includes(artifact.format)) {
      const reuse = node('button', `用作新任务输入 ${artifact.path}`); reuse.disabled = artifact.availability !== 'available' || !!pending;
      reuse.addEventListener('click', async () => {
        const identity = me; reuse.disabled = true;
        try {
          const source = await api(`/v1/artifacts/${artifact.artifact_id}`);
          if (me !== identity) return;
          if (source.availability !== 'available') throw new Error('源产物已失效，请刷新后重新选择。');
          const clearedMcp = !!$('mcp-revision').value; $('mcp-revision').value = '';
          selectedInput = source; $('input-file').value = '';
          $('input-status').textContent = `显式引用 Artifact ${source.artifact_id} · 原 Run ${id} · 原期限 ${source.expires_at} · 提交时将校验内容并创建独立副本${clearedMcp ? ' · 已取消研究 MCP 选择，切回文件任务' : ''}`;
          $('prompt').value = '仅处理本次显式输入的数据，保序生成有效 CSV、拒绝 JSON 和十进制统计。';
          $('detail').close(); $('prompt').focus(); $('error').hidden = true;
        } catch (error) { if (me === identity) $('artifact-error').textContent = error.message; }
        finally { reuse.disabled = false; }
      });
      row.append(reuse);
    } else row.append(node('small', '研究 Markdown 不符合当前文件统计输入契约'));
    $('artifacts').append(row);
  }
  if (!result?.artifacts?.length) $('artifacts').textContent = '尚无已交付文件';
  if (open && !$('detail').open) $('detail').showModal();
  ensureObservation(id, identity);
}
async function refresh() {
  if (!me || loading) return;
  loading = true; const identity = me;
  try {
    if (me.role !== 'health') {
      await configurations.refresh(); if (me !== identity) return;
      const data = await api('/v1/runs'); if (me !== identity) return;
      $('runs').replaceChildren(); $('empty').hidden = data.runs.length > 0;
      for (const run of data.runs) {
        const row = document.createElement('tr'); const name = document.createElement('td');
        name.append(node('span', run.run_id.slice(0, 8), 'mono'), node('small', new Date(run.accepted_at).toLocaleString('zh-CN')));
        const state = document.createElement('td'); state.append(pill(run.status));
        const cleanup = document.createElement('td'); cleanup.append(pill(run.cleanup.status));
        const action = document.createElement('td'); const button = node('button', '查看详情');
        button.addEventListener('click', async () => { selected = run.run_id; location.hash = run.run_id; try { await renderDetail(run.run_id, true); } catch (e) { showError(e); } });
        action.append(button); row.append(name, state, cleanup, action); $('runs').append(row);
      }
      $('updated').textContent = `最近读取 ${new Date().toLocaleTimeString('zh-CN')} · 最近 100 条`;
      if (selected) await renderDetail(selected, true);
    }
    if (me?.role !== 'caller') {
      const health = await api('/internal/health'); if (me !== identity) return;
      $('health').textContent = `运行 ${health.running} · 排队 ${health.queued} · 未完成回收 ${health.cleanup_unfinished} · 失败 ${health.failed}。读取时间 ${new Date(health.observed_at).toLocaleTimeString('zh-CN')}`;
    } else $('health').textContent = '当前调用身份可查看自己的任务。平台健康需要独立权限。';
    $('error').hidden = true;
  } catch (e) { showError(e); }
  finally { loading = false; }
}
async function connect() {
  me = await api('/v1/me'); $('login').hidden = true; $('workspace').hidden = false; $('logout').hidden = false; $('refresh').hidden = false;
  configurations.connect();
  pending = JSON.parse(sessionStorage.getItem(pendingStorageKey(me)) ?? 'null'); renderPending();
  $('identity').textContent = `${me.workspace} / ${me.actor} · ${me.role}`; $('nav-workspace').textContent = me.workspace;
  $('profile').textContent = me.profile;

  $('submission').hidden = me.role === 'health'; $('run-list').hidden = me.role === 'health';
  const hash = location.hash.slice(1); selected = /^[a-f0-9-]{36}$/.test(hash) ? hash : null;
  await refresh();
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { await api('/auth/session', { method: 'POST', body: JSON.stringify({ token: $('token').value }) }); $('token').value = ''; await connect(); } catch (e) { showError(e); }
});
$('submit-form').addEventListener('submit', async event => {
  event.preventDefault(); $('submit').disabled = true;
  try {
    if (pending) { await submitPending(); return; }
    if (!$('prompt').value.trim()) throw new Error('请填写非空任务提示词。');
    if ($('input-file').files.length && !selectedInput) throw new Error('请先上传并校验输入文件。');
    if (selectedInput && configurations.selection().mcp?.length) throw new Error('文件输入不能用于研究报告任务，请取消研究 MCP 选择后提交。');
    if (!selectedInput && configurations.selection().skills?.length) throw new Error('所选 Skill 用于文件处理，请先上传 CSV 或 JSON 输入。');
    const request = { prompt: $('prompt').value, ...configurations.selection(), output_contract: configurations.selection().mcp?.length ? 'research-report@1' : selectedInput ? 'data-statistics@1' : me.output_contract,
      ...(selectedInput ? { inputs: [{ ...(selectedInput.artifact_id ? { artifact_id: selectedInput.artifact_id } : { file_id: selectedInput.file_id }), path: `input/data.${selectedInput.format}` }] } : {}) };
    const submission = { key: crypto.randomUUID(), body: JSON.stringify(request) };
    sessionStorage.setItem(pendingStorageKey(me), JSON.stringify(submission));
    pending = submission; renderPending(); await submitPending();
  } catch (e) { showError(e); }
  finally { renderPending(); }
});
$('recover-submission').addEventListener('click', submitPending);
$('input-file').addEventListener('change', () => { selectedInput = null; $('input-status').textContent = '文件待上传校验'; });
$('clear-input').addEventListener('click', () => { selectedInput = null; $('input-file').value = ''; $('input-status').textContent = '未绑定文件 · 提交提示词任务'; });
$('upload-input').addEventListener('click', async () => {
  const file = $('input-file').files[0]; $('upload-input').disabled = true;
  try {
    if (!file || !/\.(csv|json)$/i.test(file.name)) throw new Error('请选择 CSV 或 JSON 文件。');
    if (file.size > 50 * 1024 * 1024) throw new Error('输入文件超过 50 MiB 上限。');
    const identity = me;
    const object = await api('/v1/files', { method: 'POST', headers: { 'X-File-Format': file.name.split('.').pop().toLowerCase(), 'Content-Type': 'application/octet-stream' }, body: file });
    if (me !== identity || $('input-file').files[0] !== file) return;
    selectedInput = object;
    $('input-status').textContent = `已校验 · ${object.size_bytes} bytes · ${object.file_id} · 保留至 ${new Date(object.expires_at).toLocaleString('zh-CN')}`;
    $('prompt').value = '按十进制处理输入数据。负数和零有效，非数字行进入拒绝清单；保持输入顺序，输出有效 CSV、拒绝 JSON 和统计。';
    $('error').hidden = true;
  } catch (error) { showError(error); }
  finally { $('upload-input').disabled = false; }
});
$('refresh').addEventListener('click', refresh);
$('logout').addEventListener('click', async () => { try { await api('/auth/logout', { method: 'POST' }); location.hash = ''; loggedOut(); } catch (e) { showError(e); } });
$('close-detail').addEventListener('click', () => $('detail').close());
$('cancel-run').addEventListener('click', async () => {
  const identity = me, id = selected;
  if (!identity || !id) return;
  $('cancel-run').disabled = true; $('cancel-error').textContent = '';
  try {
    await api(`/v1/runs/${id}:cancel`, { method: 'POST', headers: { 'X-Cancellation-Actor': identity.actor, 'X-Cancellation-Workspace': identity.workspace }, body: '{}' });
    if (me === identity && selected === id) await renderDetail(id);
  } catch (error) {
    if (me === identity && selected === id) $('cancel-error').textContent = `取消结果待确认。${error.message} 可重复请求同一任务，或刷新核对取消裁定。`;
  } finally { $('cancel-run').disabled = false; }
});
$('detail').addEventListener('close', () => { stopObservation(); selected = null; history.replaceState(null, '', location.pathname); });
window.addEventListener('pagehide', stopObservation);
setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
connect().catch(() => loggedOut());
