import { publishMedia } from '../src/media/publish-media.js';

const args = process.argv.slice(2);
const at = args.indexOf('--recording');
publishMedia({ dryRun: args.includes('--dry-run'), force: args.includes('--force'), upload: !args.includes('--no-upload'), only: at >= 0 ? Number(args[at + 1]) : null })
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
