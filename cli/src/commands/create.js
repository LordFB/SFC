import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import packageJson from '../../../package.json' with { type: 'json' };
import { projectName } from '../utils/names.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const templateRoot = path.join(packageRoot, 'cli', 'templates', 'capybara');
const frameworkEntries = [
  'data-adapters.js', 'database', 'env-loader.js', 'realtime-build.js', 'realtime-config.js',
  'realtime-db.js', 'server.js', 'server.prod.js', 'src', 'public/brand/sfc-mark.svg',
  'tsconfig.json', 'vite.config.build.ts'
];

function copyFramework(target) {
  for (const entry of frameworkEntries) {
    const source = path.join(packageRoot, entry);
    const destination = path.join(target, entry);
    fs.cpSync(source, destination, { recursive: true, filter: sourcePath => !sourcePath.endsWith(`${path.sep}main.ts`) });
  }
  fs.copyFileSync(path.join(templateRoot, 'src', 'main.ts'), path.join(target, 'src', 'main.ts'));
}

function generatedPackage(name) {
  const dependencies = Object.fromEntries(Object.entries(packageJson.dependencies).filter(([dependency]) => (
    !['chalk', 'commander', 'figlet', 'inquirer', 'ora', 'monaco-editor'].includes(dependency)
  )));
  return {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    engines: packageJson.engines,
    scripts: {
      build: 'node --import ./env-loader.js ./node_modules/vite/bin/vite.js build --config vite.config.build.ts',
      typecheck: 'tsc --noEmit',
      serve: 'node --import ./env-loader.js server.prod.js',
      'serve:preview': 'node --import ./env-loader.js server.prod.js --preview',
      'serve:dev': 'node --import ./env-loader.js server.js'
    },
    dependencies,
    devDependencies: packageJson.devDependencies
  };
}

export function installDependencies(target, runtime = {}) {
  const platform = runtime.platform || process.platform;
  const execute = runtime.execFileSync || execFileSync;
  if (platform === 'win32') {
    const commandProcessor = runtime.comspec || process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    execute(commandProcessor, ['/d', '/s', '/c', 'npm.cmd install'], { cwd: target, stdio: 'inherit' });
    return;
  }
  execute('npm', ['install'], { cwd: target, stdio: 'inherit' });
}

export function scaffoldProject({ cwd = process.cwd(), name, install = false } = {}) {
  const safeName = projectName(name);
  const target = path.resolve(cwd, safeName);
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) throw new Error(`Target directory is not empty: ${target}`);
  const created = !fs.existsSync(target);
  try {
    fs.mkdirSync(target, { recursive: true });
    copyFramework(target);
    fs.cpSync(templateRoot, target, { recursive: true });
    fs.renameSync(path.join(target, 'gitignore.template'), path.join(target, '.gitignore'));
    fs.writeFileSync(path.join(target, 'package.json'), `${JSON.stringify(generatedPackage(safeName), null, 2)}\n`);
    if (install) installDependencies(target);
    return target;
  } catch (error) {
    if (created) fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

export function registerCreateCommand(program) {
  program.command('create [name]')
    .description('Scaffold a runnable SFC project with a capybara-flavoured home page.')
    .option('--no-install', 'skip npm install')
    .option('--no-interactive', 'require the project name as an argument')
    .action(async (name, options) => {
      const selectedName = name || (options.interactive ? (await inquirer.prompt({ type: 'input', name: 'project', message: 'Project name:', default: 'capybara-sfc' })).project : null);
      if (!selectedName) throw new Error('A project name is required in non-interactive mode.');
      const spinner = ora('Scaffolding SFC project').start();
      try {
        const target = scaffoldProject({ name: selectedName, install: options.install });
        spinner.succeed(chalk.green(`Created ${path.basename(target)}.`));
        console.log(`\n  cd ${path.basename(target)}\n  ${options.install ? '' : 'npm install\n  '}npm run serve:dev\n`);
      } catch (error) {
        spinner.fail('Could not create project.');
        throw error;
      }
    });
}
