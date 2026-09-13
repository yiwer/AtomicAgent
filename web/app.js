import { configurationPanel } from './configurations.js';
import { observeRun } from './events.js';
const $ = id => document.getElementById(id);
const statusText = { queued: '排队中', running: '运行中', succeeded: '成功', failed: '失败', timed_out: '已超期', pending: '待回收', complete: '已核验回收', unknown: '未知', preparing: '准备环境', executing: '执行中', terminal: '终态' };
const errorText = { configuration_identity_changed: '登录身份已变化；请登录原身份找回配置操作。', configuration_conflict: '配置已被其他操作更新。请打开最新修订并重新预览。', configuration_preview_required: '请重新预览当前配置后再发布。', binding_not_allowed: '所选配置超过服务端登记的允许范围。', configuration_command_conflict: '此操作标识已绑定其他内容，请保留原操作材料核对。', authentication_required: '登录已失效，请重新登录。', forbidden: '当前身份无权执行此操作。', submission_identity_changed: '登录身份已变化，请重新登录原身份后找回提交。', config_unavailable: '登记配置不可用。', idempotency_conflict: '原提交标识已绑定其他内容；已保留恢复材料，请核对原提交。', service_unavailable: '服务暂不可用，请稍后点击刷新重试。', invalid_request: '请检查提示词与提交内容。' };
let me = null, selected = null, loading = false, pending = null, uploaded = null;
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
    if (response.status === 401 || ['submission_identity_changed', 'configuration_identity_changed'].includes(data.error)) loggedOut();
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
  me = null; selected = null; uploaded = null; pending = null; $('input-file').value = ''; $('input-status').textContent = '未绑定文件 · 提交提示词任务'; $('workspace').hidden = true; $('login').hidden = false;
  $('logout').hidden = true; $('refresh').hidden = true; $('identity').textContent = '未登录'; $('nav-workspace').textContent = '尚未登录';
  $('runs').replaceChildren(); $('result').textContent = ''; $('manifest').textContent = ''; $('skill-evidence').replaceChildren(); $('detail').close();
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
  $('result').textContent = result ? JSON.stringify(result.result, null, 2) : '尚无已提交结果';
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
    row.append(button); $('artifacts').append(row);
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
    if ($('input-file').files.length && !uploaded) throw new Error('请先上传并校验输入文件。');
    if (!uploaded && configurations.selection().skills?.length) throw new Error('所选 Skill 用于文件处理，请先上传 CSV 或 JSON 输入。');
    const request = { prompt: $('prompt').value, ...configurations.selection(), output_contract: uploaded ? 'data-statistics@1' : me.output_contract,
      ...(uploaded ? { inputs: [{ file_id: uploaded.file_id, path: `input/data.${uploaded.format}` }] } : {}) };
    const submission = { key: crypto.randomUUID(), body: JSON.stringify(request) };
    sessionStorage.setItem(pendingStorageKey(me), JSON.stringify(submission));
    pending = submission; renderPending(); await submitPending();
  } catch (e) { showError(e); }
  finally { renderPending(); }
});
$('recover-submission').addEventListener('click', submitPending);
$('input-file').addEventListener('change', () => { uploaded = null; $('input-status').textContent = '文件待上传校验'; });
$('clear-input').addEventListener('click', () => { uploaded = null; $('input-file').value = ''; $('input-status').textContent = '未绑定文件 · 提交提示词任务'; });
$('upload-input').addEventListener('click', async () => {
  const file = $('input-file').files[0]; $('upload-input').disabled = true;
  try {
    if (!file || !/\.(csv|json)$/i.test(file.name)) throw new Error('请选择 CSV 或 JSON 文件。');
    if (file.size > 50 * 1024 * 1024) throw new Error('输入文件超过 50 MiB 上限。');
    const identity = me;
    const object = await api('/v1/files', { method: 'POST', headers: { 'X-File-Format': file.name.split('.').pop().toLowerCase(), 'Content-Type': 'application/octet-stream' }, body: file });
    if (me !== identity || $('input-file').files[0] !== file) return;
    uploaded = object;
    $('input-status').textContent = `已校验 · ${object.size_bytes} bytes · ${object.file_id} · 保留至 ${new Date(object.expires_at).toLocaleString('zh-CN')}`;
    $('prompt').value = '按十进制处理输入数据。负数和零有效，非数字行进入拒绝清单；保持输入顺序，输出有效 CSV、拒绝 JSON 和统计。';
    $('error').hidden = true;
  } catch (error) { showError(error); }
  finally { $('upload-input').disabled = false; }
});
$('refresh').addEventListener('click', refresh);
$('logout').addEventListener('click', async () => { try { await api('/auth/logout', { method: 'POST' }); location.hash = ''; loggedOut(); } catch (e) { showError(e); } });
$('close-detail').addEventListener('click', () => $('detail').close());
$('detail').addEventListener('close', () => { stopObservation(); selected = null; history.replaceState(null, '', location.pathname); });
window.addEventListener('pagehide', stopObservation);
setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
connect().catch(() => loggedOut());
