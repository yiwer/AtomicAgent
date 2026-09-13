const $ = id => document.getElementById(id);
const statusText = { queued: '排队中', running: '运行中', succeeded: '成功', failed: '失败', timed_out: '已超期', pending: '待回收', complete: '已核验回收', unknown: '未知', preparing: '准备环境', executing: '执行中', terminal: '终态' };
const errorText = { authentication_required: '登录已失效，请重新登录。', forbidden: '当前身份无权执行此操作。', config_unavailable: '登记配置不可用。', idempotency_conflict: '该提交身份已绑定其他内容，请刷新后创建新任务。', service_unavailable: '服务暂不可用，请稍后点击刷新重试。', invalid_request: '请检查提示词与提交内容。' };
let me = null, selected = null, loading = false, pending = null;
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) loggedOut();
    throw new Error(errorText[data.error] ?? `请求失败：${data.error ?? response.status}`);
  }
  return data;
}
function showError(error) { $('error').textContent = error instanceof Error ? error.message : '连接失败，请重试。'; $('error').hidden = false; }
function loggedOut() {
  me = null; selected = null; $('workspace').hidden = true; $('login').hidden = false;
  $('logout').hidden = true; $('refresh').hidden = true; $('identity').textContent = '未登录'; $('nav-workspace').textContent = '尚未登录';
  $('runs').replaceChildren(); $('result').textContent = ''; $('manifest').textContent = ''; $('detail').close();
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
  fact('核验来源', run.cleanup.source); fact('输出校验', run.validation?.status === 'passed' ? '通过 summary-value@1' : run.validation?.status === 'failed' ? '不合格' : '未完成');
  fact('Attempt', run.attempt_id);
  $('result').textContent = result ? JSON.stringify(result.result, null, 2) : '尚无已提交结果';
  $('manifest').textContent = JSON.stringify(run.execution, null, 2);
  if (open && !$('detail').open) $('detail').showModal();
}
async function refresh() {
  if (!me || loading) return;
  loading = true; const identity = me;
  try {
    if (me.role !== 'health') {
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
  $('identity').textContent = `${me.workspace} / ${me.actor} · ${me.role}`; $('nav-workspace').textContent = me.workspace;
  $('profile').textContent = me.profile;
  $('mode').textContent = me.mode === 'fixture' ? '确定性实验模式：任务经过真实 API 与持久化；执行端为固定替身，不调用模型，也不创建 Docker 资源。' : '真实实验模式：使用服务端登记的 OpenSandbox 与模型配置。';
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
    const request = { prompt: $('prompt').value, profile: me.profile, output_contract: me.output_contract };
    if (!pending || pending.body !== JSON.stringify(request)) pending = { key: crypto.randomUUID(), body: JSON.stringify(request) };
    const run = await api('/v1/runs', { method: 'POST', headers: { 'Idempotency-Key': pending.key }, body: pending.body });
    pending = null; selected = run.run_id; location.hash = run.run_id; await refresh();
  } catch (e) { showError(e); }
  finally { $('submit').disabled = false; }
});
$('refresh').addEventListener('click', refresh);
$('logout').addEventListener('click', async () => { try { await api('/auth/logout', { method: 'POST' }); location.hash = ''; loggedOut(); } catch (e) { showError(e); } });
$('close-detail').addEventListener('click', () => $('detail').close());
$('detail').addEventListener('close', () => { selected = null; history.replaceState(null, '', location.pathname); });
setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
connect().catch(() => loggedOut());
