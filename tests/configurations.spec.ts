import { test, expect } from '@playwright/test';

test('A previews a configuration change, recovers its lost publication receipt, and submits the selected fixed revisions', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('访问令牌').fill('browser-test-only-credential-00000000000000000000');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '环境与模型', exact: true }).click();
  await page.getByRole('button', { name: '登记配置', exact: true }).click();
  await page.getByLabel('配置名称').fill('browser-short');
  await page.getByLabel('任务总期限（秒）').fill('30');
  await page.getByLabel('变更说明').fill('浏览器发布验证');
  await page.getByRole('button', { name: '预览变更', exact: true }).click();
  await expect(page.getByTestId('configuration-preview')).toContainText('仅影响显式选择此修订的新任务');
  await page.screenshot({ path: '.scratch/v0/evidence/ticket05/configuration-preview.png', fullPage: true });
  let drop = true;
  await page.route('**/v1/configurations/commands', async route => {
    const response = await route.fetch();
    if (drop) { drop = false; await route.abort('connectionreset'); } else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect(page.getByRole('button', { name: '找回配置操作', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '环境与模型', exact: true }).click();
  await page.getByRole('button', { name: '找回配置操作', exact: true }).click();
  await expect(page.getByTestId('configuration-result')).toContainText('browser-short@1');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#configurations').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: '.scratch/v0/evidence/ticket05/configuration-mobile.png', fullPage: true });
  expect(await page.locator('#configurations').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '关闭配置', exact: true }).click();
  await page.getByLabel('环境修订').selectOption('browser-short@1');
  await page.getByRole('button', { name: '提交任务', exact: true }).click();
  await expect(page.locator('#manifest')).toContainText('browser-short');
  await expect(page.locator('#facts')).toContainText('成功', { timeout: 15000 });
  await page.screenshot({ path: '.scratch/v0/evidence/ticket05/run-fixed-revisions.png', fullPage: true });
});

test('selected revision modes determine the pre-submit warning and incompatible combinations cannot submit', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('访问令牌').fill('browser-test-only-credential-00000000000000000000');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#identity')).toContainText('browser-maintainer');
  const response = await page.request.get('/v1/configurations'); expect(response.status()).toBe(200);
  const catalog = await response.json();
  const runtime = catalog.bindings.environments.find((b: { mode: string }) => b.mode === 'opensandbox');
  const model = catalog.bindings.models.find((b: { mode: string }) => b.mode === 'opensandbox');
  expect(runtime).toBeTruthy(); expect(model).toBeTruthy();
  for (const kind of ['environment', 'model']) {
    const command = { action: 'publish', kind, name: 'mode-preview', expected_generation: 0, reason: 'Pre-submit mode presentation only',
      content: kind === 'environment' ? { binding_ref: runtime.binding_ref, image: runtime.images[0], timeout_seconds: 30 } : { binding_ref: model.binding_ref, model: model.models[0] } };
    const preview = await (await page.request.post('/v1/configurations/preview', { data: command })).json();
    expect((await page.request.post('/v1/configurations/commands', { data: { ...command, preview_digest: preview.preview_digest }, headers: { 'Idempotency-Key': `mode-${kind}` } })).status()).toBe(200);
  }
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await page.getByLabel('环境修订').selectOption('json-lab@1'); await page.getByLabel('模型修订').selectOption('json-lab@1');
  await expect(page.locator('#mode')).toContainText('不调用模型');
  await page.getByLabel('环境修订').selectOption('mode-preview@1');
  await expect(page.locator('#mode')).toContainText('配置组合不可用');
  expect(await page.locator('#model-revision').evaluate((el: HTMLSelectElement) => el.checkValidity())).toBe(false);
  await page.getByLabel('模型修订').selectOption('mode-preview@1');
  await expect(page.locator('#mode')).toContainText('产生实际模型调用');
  await expect(page.locator('#mode')).not.toContainText('不调用模型');
  await page.screenshot({ path: '.scratch/v0/evidence/ticket05/selected-mode.png', fullPage: true });
});

test('another browser tab rotating the session cannot apply a preview under a different identity', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('访问令牌').fill('browser-test-only-credential-00000000000000000000');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '环境与模型', exact: true }).click();
  await page.getByRole('button', { name: '登记配置', exact: true }).click();
  await page.getByLabel('配置名称').fill('identity-preview'); await page.getByLabel('变更说明').fill('Identity rotation check');
  await page.getByRole('button', { name: '预览变更', exact: true }).click();
  const other = await context.newPage(); await other.goto('/');
  await other.getByRole('button', { name: '退出', exact: true }).click();
  await other.getByLabel('访问令牌').fill('browser-other-maintainer-credential-000000000000000');
  await other.getByRole('button', { name: '登录', exact: true }).click();
  await expect(other.locator('#identity')).toContainText('other-maintainer');
  const response = page.waitForResponse(r => r.url().endsWith('/v1/configurations/commands') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  expect((await response).status()).toBe(403);
  const catalog = await (await other.request.get('/v1/configurations')).json();
  expect(catalog.environments.some((r: { name: string }) => r.name === 'identity-preview')).toBe(false);
});

test('editing a non-first approved image restores that image timeout limit and publishes a valid follow-up revision', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('访问令牌').fill('browser-test-only-credential-00000000000000000000');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '环境与模型', exact: true }).click();
  await page.getByRole('button', { name: '登记配置', exact: true }).click();
  await page.getByLabel('配置名称').fill('long-image'); await page.getByLabel('获准镜像').selectOption('fixture:z-long-image');
  await page.getByLabel('任务总期限（秒）').fill('60'); await page.getByLabel('变更说明').fill('Use approved long image limit');
  await page.getByRole('button', { name: '预览变更', exact: true }).click(); await page.getByRole('button', { name: '确认发布', exact: true }).click();
  const revision = page.locator('#configuration-list article').filter({ has: page.getByRole('heading', { name: '环境 · long-image@1', exact: true }) });
  await revision.getByRole('button', { name: '发布后续修订' }).click();
  await expect(page.getByLabel('获准镜像')).toHaveValue('fixture:z-long-image');
  await expect(page.getByLabel('任务总期限（秒）')).toHaveAttribute('max', '60');
  await page.getByLabel('变更说明').fill('Preserve selected approved image');
  await page.getByRole('button', { name: '预览变更', exact: true }).click();
  await expect(page.getByTestId('configuration-preview')).toBeVisible();
  await page.getByRole('button', { name: '确认发布', exact: true }).click();
  await expect(page.getByTestId('configuration-result')).toContainText('long-image@2');
});
