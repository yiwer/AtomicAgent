import { test, expect } from '@playwright/test';

test('A recovers an accepted submission after response loss and page refresh without creating another task', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('访问令牌').fill('browser-test-only-credential-00000000000000000000');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#identity')).toContainText('browser-maintainer');
  const before = await page.locator('#runs tr').count();
  let runId = '';
  let originalKey = '';
  await page.route('**/v1/runs', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    originalKey = route.request().headers()['idempotency-key']!;
    const accepted = await route.fetch();
    expect(accepted.status()).toBe(202);
    runId = (await accepted.json()).run_id;
    await route.abort('connectionreset');
  });
  await page.getByRole('button', { name: '提交任务', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.unroute('**/v1/runs');
  await page.reload();
  await expect(page.getByRole('button', { name: '找回未确认提交', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/ticket03-pending.png', fullPage: true });
  await page.getByLabel('任务提示词').fill('Edited text must not silently replace the unresolved submission.');
  const retry = page.waitForRequest(r => r.url().endsWith('/v1/runs') && r.method() === 'POST');
  await page.getByRole('button', { name: '找回未确认提交', exact: true }).click();
  expect((await retry).headers()['idempotency-key']).toBe(originalKey);
  expect((await retry).postData()).not.toContain('Edited text');
  await expect(page.locator('#detail-id')).toHaveText(runId);
  await expect(page.locator('#result')).toContainText('three apples');
  await page.reload();
  await expect(page.locator('#detail-id')).toHaveText(runId);
  await expect(page.locator('#runs tr')).toHaveCount(before + 1);
  await page.screenshot({ path: 'test-results/ticket03-recovered.png', fullPage: true });
});

test('A retains the unresolved request for its server identity across logout without resubmitting it for another identity', async ({ page }) => {
  const login = async (token: string) => {
    await page.getByLabel('访问令牌').fill(token);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.locator('#workspace')).toBeVisible();
  };
  await page.goto('/');
  await login('browser-test-only-credential-00000000000000000000');
  let runId = '';
  await page.route('**/v1/runs', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const accepted = await route.fetch();
    runId = (await accepted.json()).run_id;
    await route.abort('connectionreset');
  });
  await page.getByRole('button', { name: '提交任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '找回未确认提交', exact: true })).toBeVisible();
  await page.unroute('**/v1/runs');
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await login('browser-other-test-credential-000000000000000000');
  await expect(page.getByRole('button', { name: '找回未确认提交', exact: true })).toBeHidden();
  await expect(page.locator('#runs tr')).toHaveCount(0);
  expect((await page.request.get(`/v1/runs/${runId}`)).status()).toBe(404);
  await page.reload();
  await expect(page.getByRole('button', { name: '找回未确认提交', exact: true })).toBeHidden();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await login('browser-test-only-credential-00000000000000000000');
  await page.getByRole('button', { name: '找回未确认提交', exact: true }).click();
  await expect(page.locator('#detail-id')).toHaveText(runId);
});
