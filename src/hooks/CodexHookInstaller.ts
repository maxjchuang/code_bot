import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type {
  CodexHookEventName,
  CodexHookInstallResult,
  CodexHookStatusReport,
  CodexHookUninstallResult,
} from './CodexHookTypes.js';

export interface CodexHookInstallerOptions {
  codexHome: string;
  projectRoot: string;
  socketPath: string;
  now?: () => string;
}

interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
  statusMessage?: string;
}

interface HookMatcherGroup {
  matcher?: string;
  hooks: HookCommand[];
}

type HooksJson = {
  hooks?: Partial<Record<CodexHookConfigEventName, HookMatcherGroup[]>>;
};

interface CodexHookManifest {
  version: 1;
  installedAt: string;
  projectRoot: string;
  socketPath: string;
  managedFiles: string[];
  managedHookEvents: CodexHookEventName[];
  managedCommand: string;
}

const MANIFEST_PATH = '.code-bot/codex-hooks/manifest.json';
const SCRIPT_PATH = '.code-bot/codex-hooks/code_bot_hook.mjs';
const HOOK_EVENTS: CodexHookEventName[] = ['session_started', 'user_prompt_submitted', 'stop', 'permission_request'];
type CodexHookConfigEventName = 'SessionStart' | 'UserPromptSubmit' | 'Stop' | 'PermissionRequest';
const CONFIG_BLOCK = [
  '# code_bot managed hooks enabled',
  '[features]',
  'hooks = true',
].join('\n');

export class CodexHookInstaller {
  constructor(private readonly options: CodexHookInstallerOptions) {}

  async status(): Promise<CodexHookStatusReport> {
    const issues: string[] = [];
    const manifest = await this.readManifest();
    const hooksRead = await this.readHooksJson();
    const configToml = await this.readOptionalText(this.configTomlPath());
    const script = await this.readOptionalText(this.scriptPath());

    if (!hooksRead.valid) {
      issues.push('hooks.json is not valid JSON');
    }
    if (!manifest) {
      issues.push('managed manifest is missing or invalid');
    }
    if (!script) {
      issues.push('managed hook script is missing');
    }

    const managedCommand = this.managedCommand();
    const hooks = hooksRead.valid ? hooksRead.value.hooks ?? {} : {};
    const hooksJsonContainsManagedHooks = HOOK_EVENTS.every((event) =>
      Array.isArray(hooks[toConfigEventName(event)]) && hooks[toConfigEventName(event)]!.some((group) => hasManagedHook(group, managedCommand)),
    );
    const configFeatureEnabled = isHooksFeatureEnabled(configToml);
    const scriptInstalled = Boolean(script);
    const manifestValid = Boolean(manifest);
    const configured = configFeatureEnabled && hooksJsonContainsManagedHooks && manifestValid && scriptInstalled;

    return {
      configured,
      configFeatureEnabled,
      hooksJsonValid: hooksRead.valid,
      hooksJsonContainsManagedHooks,
      manifestValid,
      scriptInstalled,
      recommendedCommand: configured ? '/hook-status' : '/install-hooks',
      issues,
    };
  }

  async install(): Promise<CodexHookInstallResult> {
    const hooksRead = await this.readHooksJson();
    if (!hooksRead.valid) {
      return { installed: false, status: await this.status() };
    }

    await mkdir(dirname(this.scriptPath()), { recursive: true });
    await writeFile(this.scriptPath(), this.scriptContent(), 'utf8');
    await chmod(this.scriptPath(), 0o755);

    const hooks = hooksRead.value;
    hooks.hooks ??= {};
    const managedEntry = this.managedHookEntry();
    for (const event of HOOK_EVENTS) {
      const configEvent = toConfigEventName(event);
      const groups = Array.isArray(hooks.hooks[configEvent]) ? hooks.hooks[configEvent] : [];
      const matcher = managedMatcher(event);
      const managedGroup = groups.find((group) => (group.matcher ?? '') === (matcher ?? ''));
      if (managedGroup) {
        managedGroup.hooks = [...managedGroup.hooks.filter((entry) => entry.command !== managedEntry.command), managedEntry];
      } else {
        groups.push(matcher ? { matcher, hooks: [managedEntry] } : { hooks: [managedEntry] });
      }
      hooks.hooks[configEvent] = groups;
    }
    await writeJson(this.hooksJsonPath(), hooks);

    const currentConfig = (await this.readOptionalText(this.configTomlPath())) ?? '';
    if (!isHooksFeatureEnabled(currentConfig)) {
      await writeFile(this.configTomlPath(), enableHooksFeature(currentConfig), 'utf8');
    } else if (currentConfig === '') {
      await writeFile(this.configTomlPath(), `${CONFIG_BLOCK}\n`, 'utf8');
    }

    const manifest: CodexHookManifest = {
      version: 1,
      installedAt: this.options.now?.() ?? new Date().toISOString(),
      projectRoot: this.options.projectRoot,
      socketPath: this.options.socketPath,
      managedFiles: [SCRIPT_PATH],
      managedHookEvents: HOOK_EVENTS,
      managedCommand: managedEntry.command,
    };
    await writeJson(this.manifestPath(), manifest);

    return { installed: true, status: await this.status() };
  }

  async uninstall(): Promise<CodexHookUninstallResult> {
    const manifest = await this.readManifest();
    if (!manifest || !this.isCurrentManifest(manifest)) {
      return { uninstalled: false, status: await this.status() };
    }

    const hooksRead = await this.readHooksJson();
    if (hooksRead.valid) {
      for (const event of manifest.managedHookEvents) {
        const configEvent = toConfigEventName(event);
        const groups = hooksRead.value.hooks?.[configEvent];
        if (Array.isArray(groups)) {
          const nextGroups = groups
            .map((group) => ({
              ...group,
              hooks: group.hooks.filter((entry) => entry.command !== manifest.managedCommand),
            }))
            .filter((group) => group.hooks.length > 0);
          if (nextGroups.length > 0) {
            hooksRead.value.hooks![configEvent] = nextGroups;
          } else {
            delete hooksRead.value.hooks![configEvent];
          }
        }
      }
      if (hooksRead.value.hooks && Object.keys(hooksRead.value.hooks).length === 0) {
        delete hooksRead.value.hooks;
      }
      await writeJson(this.hooksJsonPath(), hooksRead.value);
    }

    const configToml = await this.readOptionalText(this.configTomlPath());
    if (configToml?.includes(CONFIG_BLOCK)) {
      await writeFile(this.configTomlPath(), removeManagedConfigBlock(configToml), 'utf8');
    }

    for (const managedFile of manifest.managedFiles) {
      await rm(join(this.options.codexHome, managedFile), { force: true });
    }
    await rm(this.manifestPath(), { force: true });

    return { uninstalled: true, status: await this.status() };
  }

  private managedHookEntry(): HookCommand {
    return {
      type: 'command',
      command: this.managedCommand(),
      timeout: 600,
      statusMessage: 'Forwarding Codex hook to code_bot',
    };
  }

  private managedCommand(): string {
    return `node ${JSON.stringify(this.scriptPath())}`;
  }

  private scriptContent(): string {
    return `#!/usr/bin/env node
import net from 'node:net';
const socketPath = process.env.CODE_BOT_HOOK_SOCKET || ${JSON.stringify(this.options.socketPath)};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  if (!socketPath) process.exit(0);
  const client = net.createConnection(socketPath);
  let output = '';
  client.setEncoding('utf8');
  client.on('data', (chunk) => output += chunk);
  client.on('error', () => process.exit(0));
  client.on('connect', () => client.end(input));
  client.on('end', () => {
    if (output) process.stdout.write(output);
  });
});
`;
  }

  private hooksJsonPath(): string {
    return join(this.options.codexHome, 'hooks.json');
  }

  private configTomlPath(): string {
    return join(this.options.codexHome, 'config.toml');
  }

  private manifestPath(): string {
    return join(this.options.codexHome, MANIFEST_PATH);
  }

  private scriptPath(): string {
    return join(this.options.codexHome, SCRIPT_PATH);
  }

  private async readHooksJson(): Promise<{ valid: true; value: HooksJson } | { valid: false }> {
    const content = await this.readOptionalText(this.hooksJsonPath());
    if (content === undefined) {
      return { valid: true, value: {} };
    }
    try {
      const parsed = JSON.parse(content) as unknown;
      if (!isHooksJson(parsed)) {
        return { valid: false };
      }
      return { valid: true, value: parsed };
    } catch {
      return { valid: false };
    }
  }

  private async readManifest(): Promise<CodexHookManifest | undefined> {
    const content = await this.readOptionalText(this.manifestPath());
    if (content === undefined) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(content) as unknown;
      if (!isManifest(parsed)) {
        return undefined;
      }
      const normalizedFiles = parsed.managedFiles.map((file) => relative(this.options.codexHome, resolve(this.options.codexHome, file)));
      if (normalizedFiles.some((file) => file.startsWith('..'))) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private isCurrentManifest(manifest: CodexHookManifest): boolean {
    const expectedCommand = this.managedCommand();
    return (
      manifest.projectRoot === this.options.projectRoot &&
      manifest.socketPath === this.options.socketPath &&
      manifest.managedCommand === expectedCommand &&
      manifest.managedFiles.length === 1 &&
      manifest.managedFiles[0] === SCRIPT_PATH &&
      manifest.managedHookEvents.length === HOOK_EVENTS.length &&
      HOOK_EVENTS.every((event) => manifest.managedHookEvents.includes(event))
    );
  }

  private async readOptionalText(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }
}

function isHooksJson(value: unknown): value is HooksJson {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const hooks = (value as HooksJson).hooks;
  if (hooks === undefined) {
    return true;
  }
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    return false;
  }
  return Object.values(hooks).every(
    (groups) => Array.isArray(groups) && groups.every(isHookMatcherGroup),
  );
}

function isManifest(value: unknown): value is CodexHookManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const manifest = value as CodexHookManifest;
  return (
    manifest.version === 1 &&
    typeof manifest.installedAt === 'string' &&
    typeof manifest.projectRoot === 'string' &&
    typeof manifest.socketPath === 'string' &&
    typeof manifest.managedCommand === 'string' &&
    Array.isArray(manifest.managedFiles) &&
    manifest.managedFiles.every((file) => typeof file === 'string') &&
    Array.isArray(manifest.managedHookEvents) &&
    manifest.managedHookEvents.every((event) => HOOK_EVENTS.includes(event))
  );
}

function removeManagedConfigBlock(content: string): string {
  return content
    .replace(`${CONFIG_BLOCK}\n`, '')
    .replace(CONFIG_BLOCK, '')
    .replace(/\n{3,}/g, '\n\n');
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isHooksFeatureEnabled(content: string | undefined): boolean {
  if (content === undefined) {
    return true;
  }
  const explicit = readFeaturesHooksValue(content);
  return explicit !== false;
}

function enableHooksFeature(content: string): string {
  const replaced = replaceFeaturesHooksValue(content, true);
  if (replaced !== content) {
    return replaced.endsWith('\n') ? replaced : `${replaced}\n`;
  }
  const separator = content === '' || content.endsWith('\n') ? '' : '\n';
  return `${content}${separator}${CONFIG_BLOCK}\n`;
}

function readFeaturesHooksValue(content: string): boolean | undefined {
  let inFeatures = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const section = trimmed.match(/^\[([^\]]+)\]$/);
    if (section) {
      inFeatures = section[1] === 'features';
      continue;
    }
    if (!inFeatures || trimmed.startsWith('#')) {
      continue;
    }
    const match = trimmed.match(/^hooks\s*=\s*(true|false)\b/);
    if (match) {
      return match[1] === 'true';
    }
  }
  return undefined;
}

function replaceFeaturesHooksValue(content: string, enabled: boolean): string {
  let inFeatures = false;
  const lines = content.split(/\r?\n/);
  const next = lines.map((line) => {
    const trimmed = line.trim();
    const section = trimmed.match(/^\[([^\]]+)\]$/);
    if (section) {
      inFeatures = section[1] === 'features';
      return line;
    }
    if (!inFeatures || trimmed.startsWith('#')) {
      return line;
    }
    if (/^hooks\s*=\s*(true|false)\b/.test(trimmed)) {
      return line.replace(/hooks\s*=\s*(true|false)\b/, `hooks = ${enabled ? 'true' : 'false'}`);
    }
    return line;
  });
  return next.join('\n');
}

function toConfigEventName(event: CodexHookEventName): CodexHookConfigEventName {
  switch (event) {
    case 'session_started':
      return 'SessionStart';
    case 'user_prompt_submitted':
      return 'UserPromptSubmit';
    case 'stop':
      return 'Stop';
    case 'permission_request':
      return 'PermissionRequest';
  }
}

function managedMatcher(event: CodexHookEventName): string | undefined {
  switch (event) {
    case 'session_started':
      return '.*';
    case 'permission_request':
      return '.*';
    case 'user_prompt_submitted':
    case 'stop':
      return undefined;
  }
}

function hasManagedHook(group: HookMatcherGroup, managedCommand: string): boolean {
  return Array.isArray(group.hooks) && group.hooks.some((entry) => entry.command === managedCommand);
}

function isHookMatcherGroup(value: unknown): value is HookMatcherGroup {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const group = value as HookMatcherGroup;
  return (
    (group.matcher === undefined || typeof group.matcher === 'string') &&
    Array.isArray(group.hooks) &&
    group.hooks.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as HookCommand).type === 'command' &&
        typeof (entry as HookCommand).command === 'string',
    )
  );
}
