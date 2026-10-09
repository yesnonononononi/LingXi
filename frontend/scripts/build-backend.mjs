import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMaven, runMaven } from './maven-runtime.mjs';
import { prepareFrameworks } from './framework-deps.mjs';

export function buildBackend(repoRoot, goal = 'package', options = {}) {
  if (!['compile', 'test', 'verify', 'package'].includes(goal)) throw new Error('后端构建只支持 compile、test、verify、package');
  const maven = options.maven ?? resolveMaven(repoRoot);
  const repository = (options.prepare ?? prepareFrameworks)(repoRoot, maven, options);
  (options.runMaven ?? runMaven)(maven, ['-B', '-ntp', ...(options.offline ? ['-o'] : []), `-Dmaven.repo.local=${repository}`, ...(goal === 'package' ? ['-DskipTests'] : []), goal], repoRoot);
  return repository;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const goal = process.argv.slice(2).find(argument => !argument.startsWith('--')) ?? 'verify';
    buildBackend(path.resolve(path.dirname(scriptPath), '../..'), goal, { offline: process.argv.includes('--offline') });
  } catch (error) {
    console.error(`后端构建失败: ${error.message}`);
    process.exitCode = 1;
  }
}
