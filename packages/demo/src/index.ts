import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileToHtml } from '@cynodia/axiom-compiler';
import type { ApplicationGraph } from '@cynodia/axiom-core';
import { createIssueTrackerGraph } from './issue-tracker.js';
import { createInventoryGraph } from './inventory.js';
import { createOrderSystemGraph } from './order-system.js';

export { createIssueTrackerGraph, issueTrackerIds } from './issue-tracker.js';
export { createInventoryGraph, inventoryIds } from './inventory.js';
export { createOrderSystemGraph, orderSystemIds } from './order-system.js';
export { createMinimalGraph, runMinimalExample } from './minimal.js';
export { createSeatingGraph, runSeatingExample } from './minimal-server.js';
export { createOrderServerGraph, orderServerIds } from './order-server.js';
export { createDeviceMonitorGraph, deviceMonitorIds } from './device-monitor.js';

export interface DemoApplication {
  slug: string;
  createGraph(): ApplicationGraph;
}

/** Both applications are compiled and executed by the same framework packages. */
export const demoApplications: DemoApplication[] = [
  { slug: 'issue-tracker', createGraph: createIssueTrackerGraph },
  { slug: 'inventory', createGraph: createInventoryGraph },
  { slug: 'order-system', createGraph: createOrderSystemGraph },
];

export async function buildDemos(): Promise<string[]> {
  const outputDir = fileURLToPath(new URL('./public/', import.meta.url));
  await mkdir(outputDir, { recursive: true });
  const written: string[] = [];
  for (const application of demoApplications) {
    const html = compileToHtml(application.createGraph());
    const output = `${outputDir}${application.slug}.html`;
    await writeFile(output, html, 'utf8');
    written.push(output);
  }
  return written;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  buildDemos()
    .then((outputs) => {
      for (const output of outputs) {
        console.log(`Built ${output}`);
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
