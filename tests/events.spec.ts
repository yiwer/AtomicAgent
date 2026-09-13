import { test, expect } from '@playwright/test';

test('A resumes the same Run after closing its page and shows the durable Result independently of SSE text', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('访问令牌').fill('browser-test-only-credential-00000000000000000000');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '提交任务', exact: true }).click();
  await expect(page.locator('#detail')).toBeVisible();
  await expect(page.locator('#event-status')).toContainText('已连接');
  await expect(page.locator('#event-progress')).toContainText('事件序号');
  await expect(page.locator('#result')).toHaveText('尚无已提交结果');
  const url = page.url(); const id = await page.locator('#detail-id').textContent();
  await page.close();
  const reopened = await context.newPage(); await reopened.goto(url);
  await expect(reopened.locator('#detail-id')).toHaveText(id!);
  await expect(reopened.locator('#result')).toContainText('three apples');
  await expect(reopened.locator('#facts')).toContainText('已核验回收');
  await expect(reopened.locator('#event-progress')).toContainText('事件序号');
  await reopened.screenshot({ path: 'test-results/ticket04-restored.png', fullPage: true });
  await reopened.reload();
  await expect(reopened.locator('#event-progress')).toContainText('事件序号');
});

test('A recovers from network loss, deduplicates replay and treats done or EOF only as transport signals', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('访问令牌').fill('browser-test-only-credential-00000000000000000000');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.route('**/v1/runs/*/events*', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'event: done\ndata: {"status":"succeeded","result":"FAKE_RESULT"}\n\n' }));
  await page.getByRole('button', { name: '提交任务', exact: true }).click();
  await expect(page.locator('#detail')).toBeVisible();
  await expect(page.locator('#result')).toHaveText('尚无已提交结果');
  await expect(page.locator('#event-status')).toContainText('连接中断');
  const id = await page.locator('#detail-id').textContent();
  await context.setOffline(true); await page.unroute('**/v1/runs/*/events*');
  await page.waitForTimeout(2300); await context.setOffline(false);
  await expect(page.locator('#result')).toContainText('three apples');
  await expect(page.locator('#result')).not.toContainText('FAKE_RESULT');
  await expect(page.locator('#event-progress')).toContainText('事件序号 5');
  const first = await page.evaluate(async id => {
    const response = await fetch(`/v1/runs/${id}/events`); const reader = response.body!.getReader();
    const chunk = await reader.read(); await reader.cancel(); return new TextDecoder().decode(chunk.value);
  }, id);
  await page.route('**/v1/runs/*/events*', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: first + first }));
  await page.reload();
  await expect(page.locator('#event-progress')).toContainText('事件序号 5');
  await expect(page.locator('#result')).toContainText('three apples');
  await page.screenshot({ path: 'test-results/ticket04-replay.png', fullPage: true });
});

test('A reports an expired cursor and queries the authoritative Run', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('访问令牌').fill('browser-test-only-credential-00000000000000000000');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '提交任务', exact: true }).click();
  await expect(page.locator('#result')).toContainText('three apples');
  const id = await page.locator('#detail-id').textContent();
  await page.route('**/v1/runs/*/events*', route => route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ error: 'event_cursor_expired', recovery: 'query_run', run_url: `/v1/runs/${id}` }) }));
  await page.reload();
  await expect(page.locator('#event-status')).toContainText('已回到任务查询');
  await expect(page.locator('#detail-id')).toHaveText(id!);
  await expect(page.locator('#result')).toContainText('three apples');
  await expect(page.locator('#facts')).toContainText('已核验回收');
});
