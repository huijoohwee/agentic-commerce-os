import { assertAnnotationTargets, SELECTION_TARGET_SELECTOR } from 'agentic-design-system/annotation-targets';

/** Audit shopper targets in a clean browser context bound to the candidate page. */
export async function auditAnnotationTargets({ browser, url }) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  try {
    const page = await context.newPage();
    const response = await page.goto(`${url}#shop`, { waitUntil: 'domcontentloaded' });
    if (!response?.ok()) throw new Error(`Annotation target page did not load: ${response?.status() ?? 'no response'}`);
    await page.locator('#shop').waitFor({ state: 'visible' });
    await page.locator(SELECTION_TARGET_SELECTOR).first().waitFor({ state: 'visible' });
    return await page.evaluate(assertAnnotationTargets, { minTargets: 3, scrollIntoView: true });
  } finally {
    await context.close();
  }
}
