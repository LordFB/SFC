import figlet from 'figlet';
import chalk from 'chalk';
import { Command } from 'commander';
import packageJson from '../../package.json' with { type: 'json' };
import { registerAdaptCommand } from './commands/adapt.js';
import { registerAuditCommand } from './commands/audit.js';
import { registerConfigCommand } from './commands/config.js';
import { registerCreateCommand } from './commands/create.js';

export function createProgram() {
  const program = new Command();
  program
    .name('sfc-cli')
    .description('Create, configure, audit, and securely connect SFC applications.')
    .version(packageJson.version)
    .showSuggestionAfterError()
    .configureOutput({ outputError: value => chalk.red(value) });

  program.addHelpText('beforeAll', () => chalk.green(figlet.textSync('SFC', { font: 'Small' })) + '\n');
  registerCreateCommand(program);
  registerConfigCommand(program);
  registerAuditCommand(program);
  registerAdaptCommand(program);
  return program;
}

export async function run(argv = process.argv) {
  await createProgram().parseAsync(argv);
}
