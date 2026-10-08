import { publishLibrary } from '../src/recorder/publish-library.js';

const args = process.argv.slice(2);
const at = args.indexOf('--recording');
publishLibrary({
  dryRun: args.includes('--dry-run'),
  all: args.includes('--all'),
  only: at >= 0 ? Number(args[at + 1]) : null
}).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
