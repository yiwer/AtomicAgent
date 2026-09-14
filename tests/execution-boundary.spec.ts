import { test, expect } from '@playwright/test';
test('A displays the same durable denied policy, partial coverage and unknown isolation on desktop and mobile',async({page})=>{
 await page.goto('/');await page.getByLabel('访问令牌').fill('browser-test-only-credential-00000000000000000000');await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.locator('#prompt').fill('boundary-denial-fixture');await page.getByRole('button',{name:'提交任务',exact:true}).click();
 await expect(page.locator('#facts')).toContainText('policy_denied');await expect(page.locator('#boundary-summary')).toContainText('partial');await expect(page.locator('#boundary-summary')).toContainText('unknown');
 const id=await page.locator('#detail-id').textContent();const body=await page.request.get('/v1/runs/'+id);expect((await body.json()).failure).toBe('policy_denied');
 await page.reload();await expect(page.locator('#facts')).toContainText('policy_denied');await page.locator('#boundary-summary').scrollIntoViewIfNeeded();await page.screenshot({path:'.scratch/v0/evidence/ticket10/boundary-desktop.png'});
 await page.setViewportSize({width:390,height:844});await page.locator('#boundary-summary').scrollIntoViewIfNeeded();await page.screenshot({path:'.scratch/v0/evidence/ticket10/boundary-mobile.png'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.locator('#boundary-evidence').scrollIntoViewIfNeeded();await page.screenshot({path:'.scratch/v0/evidence/ticket10/boundary-mobile-evidence.png'});
 await page.getByRole('button',{name:'关闭详情',exact:true}).click();await page.route('**/v1/runs',r=>r.abort());await page.getByRole('button',{name:'刷新数据'}).click();await expect(page.getByRole('alert')).toBeVisible();await page.unroute('**/v1/runs');await page.getByRole('button',{name:'刷新数据'}).click();await expect(page.getByRole('alert')).toBeHidden();
});
