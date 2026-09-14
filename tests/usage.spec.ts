import { test, expect } from '@playwright/test';
const maintainer = 'browser-test-only-credential-00000000000000000000';
const health = 'browser-health-test-credential-00000000000000000';
const otherWorkspace = 'browser-other-test-credential-000000000000000000';

test('A shows attributed usage on the task and quota views, keeps it across refresh, refuses unauthorized reads and recovers from a failed read', async ({ page }) => {
 await page.goto('/');
 await page.getByLabel('访问令牌', { exact: true }).fill(maintainer);
 await page.getByRole('button', { name: '登录', exact: true }).click();
 await page.locator('#prompt').fill('请仅返回 JSON：summary 为 "three apples"，value 为整数 3。');
 await page.getByRole('button', { name: '提交任务', exact: true }).click();
 await expect(page.locator('#usage-summary')).toContainText('已计量', { timeout: 20_000 });
 // Estimate and confirmation are shown as separate figures for the same consumption.
 await expect(page.locator('#usage-totals')).toContainText('引擎估算 · 输入 token · 310');
 await expect(page.locator('#usage-totals')).toContainText('供应商确认 · 输入 token · 118');
 await expect(page.locator('#usage-totals')).toContainText('平台观测 · 调用次数 · 1');
 // Unmeasured consumption is shown as unknown, never as zero.
 await expect(page.locator('#usage-totals')).toContainText('估算成本（微美元） · 未知（未计量，不记为 0）');
 await expect(page.locator('#usage-summary')).toContainText('金额 cost 不支持');
 await expect(page.locator('#usage-invocations')).toContainText('模型 · 已完成 · 主执行');
 const runId = await page.locator('#detail-id').textContent();
 await page.screenshot({ path: '.scratch/v0/evidence/ticket12/usage-detail-desktop.png', fullPage: true });

 // The same durable facts come back after a full page reload.
 await page.reload();
 await expect(page.locator('#usage-totals')).toContainText('引擎估算 · 输入 token · 310', { timeout: 20_000 });
 expect(await page.locator('#detail-id').textContent()).toBe(runId);

 await page.getByRole('button', { name: '关闭详情', exact: true }).click();
 await page.getByRole('button', { name: '额度与限制', exact: true }).click();
 await expect(page.locator('#usage-scope')).toContainText('工作区 browser-lab 全部任务');
 await expect(page.locator('#usage-aggregate')).toContainText('引擎估算 · 输入 token');
 await expect(page.locator('#usage-dimensions')).toContainText('artifact_bytes');
 await expect(page.locator('#usage-dimensions')).toContainText('不支持：cost');
 await page.screenshot({ path: '.scratch/v0/evidence/ticket12/usage-quota-desktop.png', fullPage: true });
 await page.setViewportSize({ width: 390, height: 844 });
 await page.screenshot({ path: '.scratch/v0/evidence/ticket12/usage-quota-mobile.png', fullPage: true });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await page.setViewportSize({ width: 1440, height: 1000 });

 // Server-side authorization, not a hidden control: a health reader is refused and another workspace sees nothing.
 const refused = await page.request.get('/v1/usage', { headers: { Authorization: `Bearer ${health}` } });
 expect(refused.status()).toBe(403);
 const elsewhere = await page.request.get('/v1/usage', { headers: { Authorization: `Bearer ${otherWorkspace}` } });
 expect((await elsewhere.json()).scope).toBe('own-runs');
 expect((await elsewhere.json()).by_run.some((r: { run_id: string }) => r.run_id === runId)).toBe(false);

 // A failed usage read surfaces an error and the next read recovers.
 let failed = false;
 await page.route('**/v1/usage', async route => { if (failed) return route.continue(); failed = true; await route.abort(); });
 await page.getByRole('button', { name: '读取最新限额', exact: true }).click();
 await expect(page.locator('#limits-error')).toContainText('连接失败');
 await page.getByRole('button', { name: '读取最新限额', exact: true }).click();
 await expect(page.locator('#usage-aggregate')).toContainText('引擎估算 · 输入 token');
 await expect(page.locator('#limits-error')).toHaveText('');
});
