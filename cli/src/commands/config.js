import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { parseAssignment, parseEnvText, serializeEnv } from '../utils/env.js';

export function configureEnvironment({ cwd = process.cwd(), mode, assignments = [], interactive = true } = {}) {
  if (!['development', 'production'].includes(mode)) throw new Error('Mode must be development or production.');
  const filename = `.env.${mode}.local`;
  const target = path.resolve(cwd, filename);
  const values = fs.existsSync(target) ? parseEnvText(fs.readFileSync(target, 'utf8')) : new Map();
  for (const assignment of assignments) values.set(...parseAssignment(assignment));
  if (!interactive && values.size === 0) throw new Error('Provide at least one --set NAME=value in non-interactive mode.');
  fs.writeFileSync(target, serializeEnv(values, mode), { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch {}
  return { target, count: values.size };
}

async function promptAssignments(initial = []) {
  const values = [...initial];
  while (true) {
    const { name } = await inquirer.prompt({ type: 'input', name: 'name', message: 'Environment variable name (leave blank to finish):', validate: value => !value || /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || 'Use a valid environment variable name.' });
    if (!name) return values;
    const { secret } = await inquirer.prompt({ type: 'list', name: 'secret', message: `Is ${name} secret?`, choices: [{ name: 'Yes (hidden input)', value: true }, { name: 'No', value: false }] });
    const { value } = await inquirer.prompt({ type: secret ? 'password' : 'input', name: 'value', message: `${name} value:`, mask: '*' });
    values.push(`${name}=${value}`);
  }
}

export function registerConfigCommand(program) {
  program.command('config')
    .description('Configure ignored development or production environment values.')
    .option('-m, --mode <mode>', 'development or production')
    .option('-s, --set <NAME=value...>', 'set one or more values')
    .option('--no-interactive', 'require command-line options')
    .action(async options => {
      const mode = options.mode || (options.interactive ? (await inquirer.prompt({ type: 'list', name: 'mode', message: 'Environment:', choices: [{ name: 'Development', value: 'development' }, { name: 'Production', value: 'production' }] })).mode : 'development');
      const assignments = options.interactive ? await promptAssignments(options.set || []) : (options.set || []);
      const result = configureEnvironment({ mode, assignments, interactive: options.interactive });
      console.log(chalk.green(`Configured ${result.count} value(s) in ${path.basename(result.target)}.`));
      console.log(chalk.dim('The .local suffix keeps secrets out of source control.'));
    });
}
