/** Locale bundles for the MSYS2 executor's settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type ShellSettingsLocaleKey =
  | 'title' | 'description'
  | 'backend' | 'backendHint'
  | 'subsystem' | 'subsystemHint'
  | 'msysRoot' | 'msysRootHint'
  | 'bashPath' | 'bashPathHint'
  | 'timeoutMs' | 'timeoutMsHint' | 'maxOutputBytes' | 'maxOutputBytesHint'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber' | 'invalidText'

/** English copy. */
export const en: Record<ShellSettingsLocaleKey, string> = {
  title: 'MSYS2 Shell',
  description: 'The Windows platform shell: an MSYS2 (or plain POSIX bash) environment behind the bash tool and the terminal. Configuration re-applies to new commands without a reload.',
  backend: 'Backend',
  backendHint: "'msys2' injects the MSYSTEM environment and PATH surface; 'plain' runs a detected bash with no injection (Git Bash / Cygwin); 'pwsh' runs Windows PowerShell (PowerShell 7 preferred, no injection).",
  subsystem: 'Subsystem (MSYSTEM)',
  subsystemHint: "MSYS2 subsystem for PATH and toolchains: UCRT64 (default), MSYS, MINGW64, CLANG64…; 'none' disables injection.",
  msysRoot: 'MSYS2 install root',
  msysRootHint: "e.g. C:\\msys64. Empty auto-detects from common install locations.",
  bashPath: 'Bash executable',
  bashPathHint: 'Explicit bash inside the environment; empty resolves from the root or detection order.',
  timeoutMs: 'Command timeout (ms)',
  timeoutMsHint: 'How long one command may run before it is terminated.',
  maxOutputBytes: 'Output cap per stream (bytes)',
  maxOutputBytesHint: 'Output beyond this spills to a temporary file rather than being lost.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
  invalidText: 'Enter a value, or leave blank to use the default.',
}

/** Simplified Chinese copy. */
export const zh: Record<ShellSettingsLocaleKey, string> = {
  title: 'MSYS2 Shell',
  description: 'Windows 平台 shell:bash 工具与终端背后的 MSYS2(或纯 POSIX bash)环境。配置保存后对新命令即时生效,无需重启。',
  backend: '后端',
  backendHint: "'msys2' 注入 MSYSTEM 环境与 PATH 表面;'plain' 直接运行探测到的 bash,不做注入(Git Bash / Cygwin);'pwsh' 运行 Windows PowerShell(优先 PowerShell 7,不做注入)。",
  subsystem: '子系统(MSYSTEM)',
  subsystemHint: 'MSYS2 子系统决定 PATH 与工具链:UCRT64(默认)、MSYS、MINGW64、CLANG64…;none 表示不注入。',
  msysRoot: 'MSYS2 安装根',
  msysRootHint: '例如 C:\\msys64。留空则按常见安装位置自动探测。',
  bashPath: 'Bash 可执行文件',
  bashPathHint: '环境内显式指定的 bash;留空则从安装根推导或按探测顺序解析。',
  timeoutMs: '命令超时(毫秒)',
  timeoutMsHint: '单条命令允许运行多久,超时即终止。',
  maxOutputBytes: '单流输出上限(字节)',
  maxOutputBytesHint: '超出部分会转存到临时文件,而不是被丢弃。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载,暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值,已保留供你修改。',
  invalidNumber: '请填数字;留空表示使用默认值。',
  invalidText: '请输入内容;留空表示使用默认值。',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: ShellSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}
