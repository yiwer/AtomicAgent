import { test, expect } from '@playwright/test';
test('maintainer reviews limits, recovers a lost publish response and verifies the frozen limits after refresh',async({page})=>{
 await page.goto('/');await page.getByLabel('访问令牌',{exact:true}).fill('browser-test-only-credential-00000000000000000000');await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByRole('button',{name:'额度与限制',exact:true}).click();
 await page.locator('#limit-concurrency').fill('1');await page.locator('#limit-total_timeout_seconds').fill('5');await page.getByLabel('限额调整理由',{exact:true}).fill('Manual smoke limits');
 await page.getByRole('button',{name:'预览限额变更',exact:true}).click();await expect(page.locator('#limits-changes')).toContainText('concurrency');
 let lost=false;await page.route('**/v1/limits/commands',async route=>{if(!lost){lost=true;await route.fetch();await route.abort();}else await route.continue();});
 await page.getByRole('button',{name:'确认发布限额',exact:true}).click();await expect(page.getByRole('button',{name:'找回未确认限额发布'})).toBeVisible();
 await page.reload();await page.getByRole('button',{name:'额度与限制',exact:true}).click();await page.getByRole('button',{name:'找回未确认限额发布'}).click();await expect(page.locator('#limits-result')).toContainText('已发布');
 await page.screenshot({path:'.scratch/v0/evidence/ticket11/limits-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'关闭限额',exact:true}).click();await page.getByRole('button',{name:'提交任务',exact:true}).click();await expect(page.locator('#resource-limits')).toContainText('"concurrency": 1');
 await page.getByRole('button',{name:'关闭详情',exact:true}).click();await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'额度与限制',exact:true}).click();
 await page.screenshot({path:'.scratch/v0/evidence/ticket11/limits-mobile.png',fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 // Leave shared browser fixture policy at its original defaults for other tests.
 const response=await page.request.get('/v1/limits'),policy=await response.json();const command={expected_revision:policy.current.revision,values:policy.history[0].values,reason:'Restore browser defaults'};
 const preview=await(await page.request.post('/v1/limits/preview',{data:command})).json();await page.request.post('/v1/limits/commands',{headers:{'Idempotency-Key':'restore-browser-limits'},data:{...command,preview_digest:preview.preview_digest}});
});
