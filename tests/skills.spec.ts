import { test, expect } from '@playwright/test';

test('A publishes a fixed Skill, recovers a lost receipt after refresh, and exposes separate file-task evidence', async ({ page }) => {
 await page.goto('/'); await page.getByLabel('访问令牌').fill('browser-test-only-credential-00000000000000000000'); await page.getByRole('button', { name: '登录', exact: true }).click();
 await page.getByRole('button', { name: 'Skills', exact: true }).click(); await page.getByRole('button', { name: '登记配置', exact: true }).click();
 await page.getByLabel('配置类型').selectOption('skill'); await page.getByLabel('配置名称').fill('browser-statistics'); await page.getByLabel('变更说明').fill('固定文件处理 Skill');
 await page.getByRole('button', { name: '预览变更', exact: true }).click(); await expect(page.getByTestId('configuration-preview')).toContainText('atomic-registered:data-statistics');
 await page.screenshot({ path: '.scratch/v0/evidence/ticket06/skill-preview.png', fullPage: true });
 let drop = true; await page.route('**/v1/configurations/commands', async route => { const response = await route.fetch(); if (drop) { drop = false; await route.abort('connectionreset'); } else await route.fulfill({ response }); });
 await page.getByRole('button', { name: '确认发布', exact: true }).click(); await expect(page.getByRole('button', { name: '找回配置操作', exact: true })).toBeVisible();
 await page.reload(); await page.getByRole('button', { name: 'Skills', exact: true }).click(); await page.getByRole('button', { name: '找回配置操作', exact: true }).click(); await expect(page.getByTestId('configuration-result')).toContainText('browser-statistics@1');
 await page.getByRole('button', { name: '关闭配置', exact: true }).click(); await page.getByLabel('Skill 修订（可多选）').selectOption('browser-statistics@1');
 await page.getByRole('button', { name: '提交任务', exact: true }).click(); await expect(page.locator('#error')).toContainText('请先上传');
 await page.getByLabel('输入 CSV / JSON').setInputFiles({ name: 'data.csv', mimeType: 'text/csv', buffer: Buffer.from('id,category,value\na,x,0.1\nb,x,0.2\n') });
 await page.getByRole('button', { name: '上传输入', exact: true }).click(); await expect(page.locator('#input-status')).toContainText('已校验');
 await page.getByRole('button', { name: '提交任务', exact: true }).click(); await expect(page.locator('#facts')).toContainText('成功', { timeout: 15000 });
 await expect(page.locator('#skill-evidence')).toContainText('引擎已加载 是'); await expect(page.locator('#skill-evidence')).toContainText('可调用 是'); await expect(page.locator('#skill-evidence')).toContainText('实际使用 是'); await expect(page.locator('#skill-evidence')).toContainText('deterministic-fixture');
 await expect(page.locator('#result')).toContainText('0.3'); await page.reload(); await expect(page.locator('#skill-evidence')).toContainText('实际使用 是');
 await page.screenshot({ path: '.scratch/v0/evidence/ticket06/skill-evidence.png', fullPage: true });
 await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#skill-evidence').scrollIntoViewIfNeeded(); expect(await page.locator('#detail').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true); await page.screenshot({ path: '.scratch/v0/evidence/ticket06/skill-mobile.png', fullPage: true });
});
