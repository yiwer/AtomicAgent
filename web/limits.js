import { renderUsageTotals, usageFreshness } from './usage.js';
const $=id=>document.getElementById(id);
const labels={concurrency:'同时运行槽位',total_timeout_seconds:'总期限（秒）',input_bytes:'输入总量（bytes）',artifact_bytes:'产物总量（bytes）',cpu:'CPU 核数',memory_mib:'内存（MiB）'};
const key=me=>`atomicagent.limits-command:${JSON.stringify([me.workspace,me.actor])}`;
export function limitsPanel({api,identity}){
 let catalog,preview,pending,busy=false;
 const error=e=>{$('limits-error').textContent=e.message||'连接失败，请重试。';};
 function pendingUI(){ $('limits-recover').hidden=!pending;$('limits-preview-button').disabled=!!pending||busy;$('limits-publish').disabled=!!pending||busy; }
 function clear(){catalog=null;preview=null;pending=null;$('limits').close();$('open-limits').hidden=true;$('limits-fields').replaceChildren();$('limits-history').textContent='';$('limits-review').hidden=true;$('limits-error').textContent='';$('usage-scope').textContent='';$('usage-aggregate').replaceChildren();$('usage-dimensions').textContent='';}
 // Usage reads the same normalized facts the API and the task detail read; it is never a separate tally.
 async function refreshUsage(me){
  const usage=await api('/v1/usage');if(identity()!==me)return;
  $('usage-scope').textContent=`${usage.scope==='workspace'?`工作区 ${usage.workspace} 全部任务`:'当前调用身份自己的任务'} · 已计量 ${usage.measured_runs}／共 ${usage.runs} 个 Run · 未计量 ${usage.unmeasured_runs} · 在途 ${usage.in_flight_runs} · 不可用观测 ${usage.rejected_observations} · 达到限额 ${usage.limit_reached} · 可观察调用 ${usage.invocations}（未知 ${usage.unknown_invocations}）· ${usageFreshness(usage)}`;
  renderUsageTotals($('usage-aggregate'),usage.totals);
  $('usage-dimensions').textContent=`可执行预算维度：${usage.budget.enforced.map(d=>`${d.dimension}=${d.limit}`).join('、')} · 仅观测单位：${usage.budget.observed_only.join('、')} · 不支持：${usage.budget.unsupported.map(d=>`${d.dimension}（${d.reason}）`).join('、')} · 限额修订 ${usage.budget.policy_revision}`;
 }
 // Usage is only read when the quota panel is actually on screen; the background poll stays one request.
 async function refresh(showing=$('limits').open){const me=identity();if(!me||me.role==='health')return;
  const data=await api('/v1/limits');if(identity()!==me)return;catalog=data;$('open-limits').hidden=false;
  if(showing){await refreshUsage(me);if(identity()!==me)return;}
  $('limits-form').hidden=me.role!=='maintainer';$('limits-current').textContent=`当前修订 ${data.current.revision} · ${data.current.published_at} · 全平台最多 ${data.global_capacity} 个槽位`;
  $('limits-history').textContent=JSON.stringify(data.history,null,2);
  if(!$('limits-fields').children.length){for(const [field,range] of Object.entries(data.ranges)){const label=document.createElement('label');label.textContent=labels[field];label.htmlFor=`limit-${field}`;const input=document.createElement('input');input.id=`limit-${field}`;input.type='number';input.required=true;input.min=range.min;input.max=range.max;input.step=range.step;input.value=data.current.values[field];const note=document.createElement('small');note.textContent=`登记范围 ${range.min}–${range.max}`;$('limits-fields').append(label,input,note);}}
  pending=JSON.parse(sessionStorage.getItem(key(me))??'null');pendingUI();
  // A completed read clears a stale failure so recovery is visible rather than implied.
  $('limits-error').textContent='';
 }
 const headers=me=>({'X-Configuration-Actor':me.actor,'X-Configuration-Workspace':me.workspace});
 async function recover(){const me=identity(),command=pending;if(!me||!command||busy)return;busy=true;pendingUI();
  try{const receipt=await api('/v1/limits/commands',{method:'POST',headers:{...headers(me),'Idempotency-Key':command.key},body:command.body});sessionStorage.removeItem(key(me));if(identity()!==me)return;pending=null;preview=null;$('limits-review').hidden=true;$('limits-result').textContent=`修订 ${receipt.revision} 已发布；历史任务保持原清单。`;$('limits-fields').replaceChildren();await refresh();}
  catch(e){if(e.commandStatus==='not_applied'){sessionStorage.removeItem(key(me));if(identity()===me)pending=null;}if(identity()===me)error(e);}
  finally{busy=false;pendingUI();}
 }
 $('open-limits').onclick=async()=>{try{await refresh(true);$('limits').showModal();}catch(e){error(e);}};
 $('close-limits').onclick=()=>$('limits').close();
 $('limits-refresh').onclick=async()=>{if(pending)return;preview=null;$('limits-review').hidden=true;$('limits-fields').replaceChildren();try{await refresh(true);}catch(e){error(e);}};
 $('limits-form').onsubmit=async event=>{event.preventDefault();const me=identity();if(!me||pending||busy)return;busy=true;pendingUI();$('limits-error').textContent='';
  const command={expected_revision:catalog.current.revision,values:Object.fromEntries(Object.keys(labels).map(field=>[field,Number($(`limit-${field}`).value)])),reason:$('limits-reason').value};
  try{const data=await api('/v1/limits/preview',{method:'POST',headers:headers(me),body:JSON.stringify(command)});if(identity()!==me)return;preview={...command,preview_digest:data.preview_digest};$('limits-changes').textContent=JSON.stringify(data.changes,null,2);$('limits-review').hidden=false;}
  catch(e){error(e);}finally{busy=false;pendingUI();}
 };
 $('limits-form').oninput=()=>{preview=null;$('limits-review').hidden=true;};
 $('limits-publish').onclick=async()=>{const me=identity();if(!me||!preview||pending||busy)return;pending={key:crypto.randomUUID(),body:JSON.stringify(preview)};sessionStorage.setItem(key(me),JSON.stringify(pending));await recover();};
 $('limits-recover').onclick=recover;
 return {refresh,logout:clear};
}
