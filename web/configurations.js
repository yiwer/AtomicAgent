const $ = id => document.getElementById(id);
const storageKey = identity => `atomicagent.configuration-command:${JSON.stringify([identity.workspace, identity.actor])}`;
const labels = { binding_ref: '登记身份', timeout_seconds: '任务总期限（秒）', image: '镜像', model: '模型', enabled: '允许新任务',
  endpoint: '模型端点', credential_identity: '凭据身份', approval_identity: '用途授权身份', provider_ref: '执行服务身份', provider_endpoint: '执行服务端点', linux_node: '节点身份', node: 'Node 版本', sdk: 'Claude SDK', cli: 'Claude CLI', mode: '执行模式', runtime: '容器 runtime' };
export function configurationPanel({ api, identity }) {
  let catalog, pending, preview, editGeneration = 0, loading = false;
  const active = () => identity();
  function node(tag, text) { const el = document.createElement(tag); el.textContent = text; return el; }
  function fail(error) { $('configuration-error').textContent = error.message || '连接失败，请重试。'; $('configuration-error').hidden = false; }
  function select(id, items, previous) {
    const element = $(id); element.replaceChildren();
    for (const [value, text] of items) { const option = node('option', text); option.value = value; element.append(option); }
    if (items.some(([value]) => value === previous)) element.value = previous;
  }
  function pendingUI() {
    $('configuration-pending').hidden = !pending;
    $('commit-configuration').disabled = !!pending;
    $('new-configuration').disabled = !!pending;
  }
  function setPending() {
    pending = JSON.parse(sessionStorage.getItem(storageKey(active())) ?? 'null'); pendingUI();
  }
  function selectionMode() {
    if (!catalog) return;
    const environment = catalog.environments.find(r => `${r.name}@${r.version}` === $('environment-revision').value);
    const model = catalog.models.find(r => `${r.name}@${r.version}` === $('model-revision').value);
    const compatible = environment?.available && model?.available && environment.mode === model.mode;
    $('model-revision').setCustomValidity(compatible ? '' : '请选择同一执行模式的可用环境和模型修订。');
    $('mode').textContent = !compatible ? '配置组合不可用：请选择同一执行模式的可用环境和模型修订。'
      : environment.mode === 'fixture' ? '确定性实验模式：所选修订使用受控替身，不调用模型，也不创建 Docker 资源。'
      : '真实实验模式：所选修订会使用 OpenSandbox 与登记模型，产生实际模型调用及执行资源。兼容性未取证。';
    $('profile').textContent = `${$('environment-revision').value || '无可用环境'} + ${$('model-revision').value || '无可用模型'}`;
  }
  $('environment-revision').onchange = selectionMode; $('model-revision').onchange = selectionMode;
  async function refresh() {
    const me = active(); if (!me || me.role === 'health' || loading) return;
    loading = true;
    try {
      const data = await api('/v1/configurations'); if (active() !== me) return;
      catalog = data;
      for (const [id, revisions] of [['environment-revision', data.environments], ['model-revision', data.models]]) {
        select(id, revisions.filter(r => r.available).map(r => [`${r.name}@${r.version}`, `${r.name}@${r.version}${id === 'model-revision' ? ' · 兼容性未验证' : ''}`]), $(id).value);
      }
      const previousSkills = [...$('skill-revisions').selectedOptions].map(o => o.value);
      select('skill-revisions', data.skills.filter(r => r.available).map(r => [`${r.name}@${r.version}`, `${r.name}@${r.version}`]));
      for (const o of $('skill-revisions').options) o.selected = previousSkills.includes(o.value);
      select('mcp-revision', [['', '不选择'], ...data.mcps.filter(r => r.available).map(r => [`${r.name}@${r.version}`, `${r.name}@${r.version}`])], $('mcp-revision').value);
      selectionMode();
      $('configuration-list').replaceChildren();
      for (const revision of [...data.environments, ...data.models, ...data.skills, ...data.mcps]) {
        const row = node('article', '');
        row.append(node('h3', `${revision.kind === 'mcp' ? 'MCP' : revision.kind === 'skill' ? 'Skill' : revision.kind === 'environment' ? '环境' : '模型'} · ${revision.name}@${revision.version}`));
        row.append(node('p', `${revision.enabled ? '已启用' : '已停用'} · ${revision.available ? '可供新任务选择' : '新任务不可选'} · 兼容性未验证`));
        row.append(node('p', `${revision.published_by} · ${revision.published_at} · ${revision.reason}`));
        row.append(node('pre', JSON.stringify(revision.definition ?? revision.content, (key, value) => key === 'snapshot' ? '[固定材料正文省略，修订摘要已固定]' : value, 2)));
        if (revision.kind === 'mcp') {
          const observation = data.mcp_probes[`${revision.name}@${revision.version}`];
          row.append(node('p', observation ? `连接 ${observation.connected} · 工具目录 ${observation.callable} · GET 授权 ${observation.authorized ?? '未知'} · 已取来源 ${observation.acquired} · ${observation.observed_at} · ${Date.now()-Date.parse(observation.observed_at)>60000 ? '已过期，健康未知' : '新鲜观测'} · ${observation.source}` : '尚未探测：连接、工具和实际授权均未知'));
          const probe = node('button', '探测只读 MCP'); probe.disabled = !revision.available;
          probe.onclick = async () => { const me = active(); probe.disabled = true; try { await api('/v1/configurations/mcp-probe', { method: 'POST', headers: headers(me), body: JSON.stringify({ id: revision.name, version: revision.version }) }); await refresh(); } catch (error) { fail(error); probe.disabled = false; } };
          row.append(probe);
        }
        const edit = node('button', '发布后续修订'); edit.disabled = !!pending;
        edit.onclick = () => editRevision(revision);
        const toggle = node('button', revision.enabled ? '停用修订' : '启用修订'); toggle.disabled = !!pending;
        toggle.onclick = () => showPreview({ action: revision.enabled ? 'disable' : 'enable', kind: revision.kind, name: revision.name,
          version: revision.version, expected_generation: revision.generation, reason: revision.enabled ? 'Maintainer disabled new admission' : 'Maintainer enabled new admission' }).catch(fail);
        row.append(edit, toggle); $('configuration-list').append(row);
      }
      $('configuration-error').hidden = true;
    } finally { loading = false; }
  }
  function bindingValues() {
    const environment = $('configuration-kind').value === 'environment';
    const skill = ['skill','mcp'].includes($('configuration-kind').value);
    const mcp = $('configuration-kind').value === 'mcp';
    $('configuration-value').hidden = skill; $('configuration-value').required = !skill; $('configuration-value-label').hidden = skill;
    const binding = (environment ? catalog.bindings.environments : catalog.bindings.models).find(b => b.binding_ref === $('configuration-binding').value);
    select('configuration-value', (environment ? binding?.images : binding?.models)?.map(v => [v, v]) ?? []);
    $('configuration-value-label').textContent = environment ? '获准镜像' : '获准模型';
    $('configuration-timeout-field').hidden = !environment; $('configuration-timeout').required = environment;
    if (environment && binding) { $('configuration-timeout').max = binding.image_limits[$('configuration-value').value]; $('configuration-timeout').value = binding.image_limits[$('configuration-value').value]; }
  }
  function imageLimit() {
    if ($('configuration-kind').value !== 'environment') return;
    const binding = catalog.bindings.environments.find(b => b.binding_ref === $('configuration-binding').value);
    if (!binding || !Object.hasOwn(binding.image_limits, $('configuration-value').value)) return;
    const limit = binding.image_limits[$('configuration-value').value]; $('configuration-timeout').max = limit;
    if (Number($('configuration-timeout').value) > limit) $('configuration-timeout').value = limit;
  }
  $('configuration-value').onchange = imageLimit;
  function bindings() {
    const environment = $('configuration-kind').value === 'environment';
    const skill = ['skill','mcp'].includes($('configuration-kind').value);
    const mcp = $('configuration-kind').value === 'mcp';
    select('configuration-binding', (mcp ? catalog.bindings.mcps : skill ? catalog.bindings.skills : environment ? catalog.bindings.environments : catalog.bindings.models).map(b => [b.binding_ref,
      mcp ? `${b.server}@${b.server_version} · ${b.mode}` : skill ? `${b.entry} · ${b.content_digest.slice(0, 12)}` : environment ? `${b.mode} · Claude SDK ${b.sdk} · ${b.binding_ref.slice(-8)}` : `${b.mode} · ${b.endpoint} · ${b.binding_ref.slice(-8)}`]));
    bindingValues();
  }
  function editRevision(revision) {
    preview = null; $('configuration-preview').hidden = true; $('configuration-form').hidden = false;
    $('configuration-kind').disabled = !!revision; $('configuration-name').readOnly = !!revision;
    $('configuration-kind').value = revision?.kind ?? 'environment'; $('configuration-name').value = revision?.name ?? '';
    $('configuration-reason').value = ''; editGeneration = revision?.generation ?? 0; bindings();
    if (revision) {
      $('configuration-binding').value = revision.content.binding_ref; bindingValues();
      $('configuration-value').value = revision.content.image ?? revision.content.model;
      if (revision.kind === 'environment') $('configuration-timeout').value = revision.content.timeout_seconds;
      imageLimit();
    }
    $('configuration-form').scrollIntoView({ block: 'nearest' });
  }
  const headers = me => ({ 'X-Configuration-Actor': me.actor, 'X-Configuration-Workspace': me.workspace });
  async function showPreview(command) {
    const me = active();
    const data = await api('/v1/configurations/preview', { method: 'POST', headers: headers(me), body: JSON.stringify(command) });
    if (active() !== me) return;
    preview = { ...data.command, preview_digest: data.preview_digest };
    $('configuration-changes').textContent = data.changes.map(c => `${labels[c.field] ?? c.field}: ${c.before ?? '未登记'} → ${c.after}`).join('\n') || '内容相同，仍将生成新修订';
    $('configuration-impact').textContent = `引用此配置的旧 Run：${data.impact.existing_run_count}\n` + JSON.stringify(data.impact.existing_runs, null, 2) + (data.impact.truncated ? '\n只显示最近 100 条引用' : '');
    $('commit-configuration').textContent = command.action === 'publish' ? '确认发布' : command.action === 'disable' ? '确认停用' : '确认启用';
    $('configuration-preview').hidden = false; $('configuration-error').hidden = true;
    $('configuration-preview').scrollIntoView({ block: 'nearest' });
  }
  async function recover() {
    const me = active(), operation = pending; if (!me || !operation) return;
    $('recover-configuration').disabled = true;
    try {
      const receipt = await api('/v1/configurations/commands', { method: 'POST', headers: { ...headers(me), 'Idempotency-Key': operation.key }, body: operation.body });
      sessionStorage.removeItem(storageKey(me)); if (active() !== me) return;
      pending = null; preview = null; $('configuration-preview').hidden = true; $('configuration-form').hidden = true;
      $('configuration-result').textContent = `已确认 ${receipt.action} · ${receipt.revision.name}@${receipt.revision.version} · 操作 ${receipt.command_id}`;
      await refresh(); await audit();
    } catch (error) {
      if (error.commandStatus === 'not_applied') {
        sessionStorage.removeItem(storageKey(me));
        if (active() === me) { pending = null; preview = null; $('configuration-preview').hidden = true; await refresh(); }
      }
      fail(error);
    } finally { $('recover-configuration').disabled = false; pendingUI(); }
  }
  async function audit() {
    const me = active(); if (!me || me.role !== 'maintainer') return;
    const data = await api('/v1/configurations/audit'); if (active() !== me) return;
    $('configuration-audit').textContent = data.records.map(r => `${r.recorded_at} ${r.actor} ${r.action} ${r.outcome} ${r.resource_id ?? ''} ${r.operation_id ?? ''}`).join('\n') || '尚无配置操作';
  }
  $('open-configurations').onclick = async () => {
    try { setPending(); await refresh(); await audit(); if (!$('configurations').open && active()) $('configurations').showModal(); } catch (e) { fail(e); }
  };
  $('open-mcp').onclick = () => $('open-configurations').click();
  $('open-skills').onclick = () => $('open-configurations').click();
  $('close-configurations').onclick = () => $('configurations').close();
  $('new-configuration').onclick = () => editRevision(null);
  $('configuration-kind').onchange = bindings; $('configuration-binding').onchange = bindingValues;
  $('configuration-form').oninput = () => { preview = null; $('configuration-preview').hidden = true; };
  $('configuration-form').onsubmit = async event => {
    event.preventDefault();
    const environment = $('configuration-kind').value === 'environment';
    try { await showPreview({ action: 'publish', kind: $('configuration-kind').value, name: $('configuration-name').value, expected_generation: editGeneration,
      content: { binding_ref: $('configuration-binding').value, ...(['skill','mcp'].includes($('configuration-kind').value) ? {} : environment ? { image: $('configuration-value').value, timeout_seconds: Number($('configuration-timeout').value) } : { model: $('configuration-value').value }) },
      reason: $('configuration-reason').value }); } catch (error) { fail(error); }
  };
  $('commit-configuration').onclick = async () => {
    if (!preview || pending) return;
    try {
      const operation = { key: crypto.randomUUID(), body: JSON.stringify(preview) };
      sessionStorage.setItem(storageKey(active()), JSON.stringify(operation)); pending = operation; pendingUI(); await recover();
    } catch (error) { fail(error); }
  };
  $('recover-configuration').onclick = recover;
  return { refresh,
    connect() { $('open-mcp').hidden = active()?.role !== 'maintainer'; $('open-skills').hidden = active()?.role !== 'maintainer'; $('open-configurations').hidden = active()?.role !== 'maintainer'; setPending(); },
    logout() { $('open-mcp').hidden = true; $('mcp-revision').replaceChildren(); $('open-skills').hidden = true; $('skill-revisions').replaceChildren(); catalog = null; pending = null; preview = null; $('configurations').close(); $('open-configurations').hidden = true;
      $('configuration-list').replaceChildren(); $('configuration-audit').textContent = ''; $('configuration-result').textContent = ''; $('configuration-error').hidden = true;
      $('configuration-preview').hidden = true; $('configuration-form').hidden = true; $('environment-revision').replaceChildren(); $('model-revision').replaceChildren(); pendingUI(); },
    selection() {
      const ref = value => { const at = value.lastIndexOf('@'); return { profile_id: value.slice(0, at), version: value.slice(at + 1) }; };
      const skills = [...$('skill-revisions').selectedOptions].map(o => { const r = ref(o.value); return { id: r.profile_id, version: r.version, must_use: $('skills-must-use').checked }; });
      return { environment: ref($('environment-revision').value), model: ref($('model-revision').value), ...($('mcp-revision').value ? { mcp: [{ id: ref($('mcp-revision').value).profile_id, version: ref($('mcp-revision').value).version }] } : {}), ...(skills.length ? { skills } : {}) };
    },
  };
}
