// Events prompt an authoritative read. They never commit business state in the page.
export function observeRun({ id, identity, onChange, onUnauthorized, onStatus, onProgress }) {
  const controller = new AbortController();
  const key = `atomicagent.cursor:${JSON.stringify([identity.workspace, identity.actor, id])}`;
  let sequence = Number(sessionStorage.getItem(key) ?? 0);
  if (!Number.isSafeInteger(sequence) || sequence < 0) sequence = 0;
  if (sequence) onProgress(`恢复事件序号 ${sequence} · 正在核对任务状态`);
  let stopped = false;
  const stop = () => { stopped = true; controller.abort(); };
  const reconnectDelay = () => new Promise(resolve => {
    const finished = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finished); resolve(); };
    const timer = setTimeout(finished, 1000); controller.signal.addEventListener('abort', finished, { once: true });
    if (stopped) finished();
  });
  void (async () => {
    while (!stopped) {
      let reader;
      try {
        onStatus('正在连接进度');
        const response = await fetch(`/v1/runs/${id}/events${sequence ? `?cursor=${id}:${sequence}` : ''}`, {
          signal: controller.signal, headers: { 'X-Observation-Actor': identity.actor, 'X-Observation-Workspace': identity.workspace },
        });
        if (response.status === 401 || response.status === 403) { onUnauthorized(); stop(); break; }
        if (response.status === 410 || response.status === 409) {
          sequence = 0; sessionStorage.removeItem(key);
          await onChange();
          onStatus('事件游标不可用，已回到任务查询');
          if (response.status === 410) { stop(); break; }
        } else {
          if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('stream_unavailable');
          onStatus('进度已连接');
          reader = response.body.getReader();
          const decoder = new TextDecoder(); let buffer = '';
          while (!stopped) {
            const chunk = await reader.read(); if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            if (buffer.length > 65536) throw new Error('event_frame_limit');
            let end, changed = false;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const type = frame.match(/^event: (.*)$/m)?.[1];
              if (type === 'reset') { sequence = 0; sessionStorage.removeItem(key); throw new Error('cursor_reset'); }
              if (type !== 'progress') continue;
              const data = JSON.parse(frame.match(/^data: (.*)$/m)?.[1] ?? 'null');
              if (data?.version !== 1 || data.run_id !== id || !Number.isSafeInteger(data.sequence) ||
                  data.sequence <= 0 || data.event_id !== `${id}:${data.sequence}` ||
                  frame.match(/^id: (.*)$/m)?.[1] !== data.event_id) throw new Error('invalid_event');
              if (data.sequence <= sequence) continue;
              if (sequence && data.sequence !== sequence + 1) { sequence = 0; sessionStorage.removeItem(key); throw new Error('event_gap'); }
              sequence = data.sequence; sessionStorage.setItem(key, String(sequence)); changed = true;
              onProgress(`最近事件序号 ${sequence} · ${new Date(data.recorded_at).toLocaleTimeString('zh-CN')}`);
            }
            if (changed && !stopped) await onChange();
          }
        }
      } catch { /* No transport text or event payload becomes a displayed error or Result. */ }
      finally { if (reader) await reader.cancel().catch(() => {}); }
      if (!stopped) {
        onStatus('进度连接中断，正在查询任务并重连');
        try { await onChange(); } catch { /* A later authoritative refresh can recover. */ }
        await reconnectDelay();
      }
    }
  })();
  return stop;
}
