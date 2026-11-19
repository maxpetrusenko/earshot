/** True when Playwright can launch Chromium here. The self-hosted CI runner has no browser installed, so the tests that need one skip there. */
export async function browserAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    const b = await chromium.launch();
    await b.close();
    return true;
  } catch {
    return false;
  }
}
