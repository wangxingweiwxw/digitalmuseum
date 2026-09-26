import { upload, wrangler } from './upload-r2.mjs';

await upload('--remote');
await wrangler(['deploy']);
