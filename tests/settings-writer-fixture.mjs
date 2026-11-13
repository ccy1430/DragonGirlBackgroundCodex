import { Store } from '../plugins/dragon-background/src/core.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const [directory, field, iterations] = process.argv.slice(2);
const store = new Store(directory);
for (let i = 0; i < Number(iterations); i++) {
  await store.mutate(async current => {
    await delay(5);
    return { ...current, [field]: current[field] + 1 };
  });
}
