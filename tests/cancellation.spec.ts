import { test, expect } from '@playwright/test';
test('A cancels through the authorized API, refreshes durable adjudication, and shows independent actual stop and cleanup',async({page})=>{
  test.setTimeout(45000);
  await page.goto('/'); await page.getByLabel('访问令牌').fill('browser-test-only-credential-00000000000000000000'); await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('button',{name:'提交任务',exact:true}).click();
  await expect(page.locator('#detail')).toBeVisible();
  await page.route('**/v1/runs/*:cancel',route=>route.abort());
  await page.getByRole('button',{name:'取消任务',exact:true}).click(); await expect(page.locator('#cancel-error')).toContainText('取消结果待确认');
  await page.unroute('**/v1/runs/*:cancel');
  await page.getByRole('button',{name:'取消任务',exact:true}).click(); await expect(page.locator('#cancel-facts')).toContainText('取消裁定：已接受');
  await expect(page.locator('#facts')).toContainText('已取消'); await expect(page.locator('#cancel-facts')).toContainText('实际停止：待核验');
  await page.reload(); await expect(page.locator('#cancel-facts')).toContainText('取消裁定：已接受');
  await page.getByRole('button',{name:'核对取消请求',exact:true}).click();
  await page.locator('#cancellation').scrollIntoViewIfNeeded(); await page.screenshot({path:'.scratch/v0/evidence/ticket09/cancel-desktop.png'});
  await expect(page.locator('#cancel-facts')).toContainText('已核验停止',{timeout:35000}); await expect(page.locator('#facts')).toContainText('已核验回收');
  await page.setViewportSize({width:390,height:844}); await page.locator('#cancellation').scrollIntoViewIfNeeded(); await page.screenshot({path:'.scratch/v0/evidence/ticket09/cancel-mobile.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
