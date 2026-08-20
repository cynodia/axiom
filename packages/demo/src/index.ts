import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compileToHtml } from '@axiom/compiler';
import { createIssueTrackerModel } from './model.js';

export async function buildDemo(): Promise<string> {
  const graph = createIssueTrackerModel();
  const html = compileToHtml(graph);
  const output = fileURLToPath(new URL('./index.html', import.meta.url));
  await writeFile(output, html, 'utf8');
  return output;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  buildDemo()
    .then((output) => {
      console.log(`Demo written to ${output}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
