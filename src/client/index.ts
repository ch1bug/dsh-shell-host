/**
 * dsh-shell-host browser half (#169) — the terminal row's configuration page,
 * registered into the host plugin manager's `plugins.row.config` slot under
 * the key `dsh-shell-host#terminal` (ADR-0013 revision: the client half is
 * the tools-only plugin's ONE declared exception, the official decoration
 * template shape: `dsh.client{platform:'web'}` + `./client` export).
 *
 * The page is the human's GUI over the custom-preset surface — NOT an agent
 * write path (ADR-0018 §3 unchanged: registration is human-written). Its
 * save issues exactly ONE `set` path op over the volatile `custom` subtree
 * through the host's form contract; the terminal entry's host half
 * materializes the array into the custom.d FILE FAMILY (decision B on
 * #169 — the files stay the one authority, the page save takes effect on
 * the next launch (D1); the ticket (#169, ch1bug/dsh-shell-host) carries
 * the contract's primary-source anchors).
 *
 * React comes from the host's browser module table (the baseline; L506280 of
 * the host asar) — no duplicate React installation, no CDN script;
 * `dsh.client.external` stays empty. The build must leave `require('react')`
 * as a bare external (tsdown `deps.neverBundle`, format cjs).
 *
 * A save conflict (another writer moved the revision) is reported and
 * recoverable: the page says so and the next save re-reads the revision from
 * the form's snapshot (D8 UX self-ruled). Deleted presets disappear from the
 * array on save — deletion is unambiguous (story 15). Built-in presets are
 * NOT listed: the browser face has no channel to the launcher table (the
 * agent face's terminal_list is not client-reachable) — a declared spec
 * shortfall (#169 票面留档).
 * @module dsh-shell-host/client
 */

/** The browser module table provides `require` to materialized bundles. */
declare function require(id: string): any

/** The baseline React (never bundled; resolved by the host module system). */
const React = require('react') as Record<string, any>

/** The `plugins.row.config` key: `<package name>#<row id>` (host contract). */
export const ROW_KEY = 'dsh-shell-host#terminal'

/** The one editable subtree — the volatile `custom` field of the terminal
 * entry's settings namespace. The page's write surface is EXACTLY this. */
const CUSTOM_PATH = 'custom'

interface SettingsPathOp {
  op: 'set' | 'unset'
  path: (string | number)[]
  value?: unknown
}

/** The #54 custom-preset shape (duck-typed: the client half has no type
 * view of the host half's modules — plain JS over the wire values). */
interface PresetDraft {
  id: string
  transport: 'local' | 'ssh'
  base?: string
  executable?: string[]
  argv?: string[]
  cwd?: string
  host?: string
  port?: number
  shell?: string
}

/** The host form contract (duck-typed over ConfigFormController, asar
 * L537375-537390: `mutate(ops, expectedRevision)` → `settings.mutate(ns,
 * ownedOps, revision)`; a refused write makes the controller `recover()` and
 * answer `false` — the conflict path is the FALSE branch, not a throw):
 * state is the form store (getSnapshot → { view, revision }); mutate applies
 * ordered path ops under the optimistic revision and answers acceptance. */
interface FormContract {
  state?: { getSnapshot?: () => { view?: Record<string, unknown>; revision?: number } }
  mutate?: (operations: SettingsPathOp[], expectedRevision?: number) => Promise<boolean>
}

function snapshotOf(form: FormContract): { view?: Record<string, unknown>; revision?: number } {
  const state = form?.state as { getSnapshot?: () => { view?: Record<string, unknown>; revision?: number } } | undefined
  return typeof state?.getSnapshot === 'function' ? state.getSnapshot() : ((state ?? {}) as never)
}

function presetsOf(form: FormContract): PresetDraft[] {
  const raw = snapshotOf(form)?.view?.[CUSTOM_PATH]
  return Array.isArray(raw) ? (raw as PresetDraft[]) : []
}

const h: typeof React.createElement = React.createElement

/** The live launch-command preview (story 5): executable + argv, quoted the
 * way the host half quotes spaced paths (argv atoms verbatim). A base-inheriting
 * row shows its inheritance source — the BUILT-IN table is not client-visible,
 * so the concrete executable resolves at launch (labeled as such, never
 * pretended). */
function previewOf(preset: PresetDraft): string {
  if (preset.transport === 'ssh') {
    return `ssh ${preset.host ?? '<host>'}${preset.port === undefined ? '' : ` -p ${preset.port}`}${preset.shell === undefined ? '' : ` ${preset.shell}`}`
  }
  const candidates = preset.executable ?? []
  if (candidates.length === 0) {
    return preset.base === undefined
      ? '<no executable>'
      : `继承内置预设 ${preset.base}${(preset.argv ?? []).length > 0 ? ` ${(preset.argv ?? []).join(' ')}` : ''}（实际可执行路径以启动时的内置表为准）`
  }
  const exe = candidates[0]!.includes(' ') ? `"${candidates[0]}"` : candidates[0]!
  return [exe, ...(preset.argv ?? [])].join(' ')
}

/** The client mirror of the #105 matrix's DECIDABLE-without-machine items —
 * the page-side face of story 9. The registration gate re-judges everything
 * at mount (the one identical gate, D4); this mirror exists so an invalid
 * draft fails the SAVE loudly instead of traveling silently (a hostile id
 * would be skipped by the transport with no channel back to the page).
 * Intentional duplication: the browser half has no import channel into the
 * host half's modules. */
const ID_PATTERN_MIRROR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const FORBIDDEN_IN_EXECUTABLE_MIRROR = /["'`&;|<>()$*?!^%\u0000-\u001f]/

function validateDraft(preset: PresetDraft): string | undefined {
  if (preset.id === '' || !ID_PATTERN_MIRROR.test(preset.id)) {
    return `id 必须匹配 ${ID_PATTERN_MIRROR.source}，got: ${JSON.stringify(preset.id)}`
  }
  if (preset.transport === 'ssh') {
    if ((preset.host ?? '') === '') return 'ssh 预设必须有 host'
    if (preset.port !== undefined && (!Number.isInteger(preset.port) || preset.port <= 0)) {
      return `port 必须是正整数，got: ${JSON.stringify(preset.port)}`
    }
    return undefined
  }
  if (preset.base !== undefined && (preset.executable ?? []).length === 0) return undefined
  const candidates = preset.executable ?? []
  if (candidates.length === 0) return 'local 预设至少需要一个可执行路径，或声明 base 继承'
  for (const candidate of candidates) {
    if (!/^[A-Za-z]:[\\/]|^\//.test(candidate)) return `${candidate}: 可执行路径必须是绝对路径`
    if (!candidate.includes('/') && !candidate.includes('\\')) return `${candidate}: 必须含路径分隔符（裸名沿 PATH 解析可被改名劫持）`
    if (FORBIDDEN_IN_EXECUTABLE_MIRROR.test(candidate)) return `${candidate}: 含引号或 shell 元字符`
    if (process.platform === 'win32' && (candidate.match(/:/g)?.length ?? 0) > 1) {
      return `${candidate}: win32 拒 NTFS 备用数据流（第二个冒号）`
    }
  }
  if (preset.cwd !== undefined && preset.cwd !== '' && !/^[A-Za-z]:[\\/]|^\//.test(preset.cwd)) {
    return 'cwd 必须是绝对路径'
  }
  return undefined
}

/** One blank row (add form seed). */
function blankDraft(): PresetDraft {
  return { id: '', transport: 'local', executable: [], argv: [] }
}

function TextField(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean }) {
  return h('label', { style: { display: 'block', margin: '4px 0' } },
    h('span', { style: { display: 'inline-block', minWidth: 90, marginRight: 8 } }, props.label),
    h('input', {
      value: props.value,
      placeholder: props.placeholder,
      disabled: props.disabled === true,
      onChange: (e: { target: { value: string } }) => props.onChange(e.target.value),
      style: { width: '100%', maxWidth: 480 },
    }),
  )
}

function SelectField(props: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return h('label', { style: { display: 'block', margin: '4px 0' } },
    h('span', { style: { display: 'inline-block', minWidth: 90, marginRight: 8 } }, props.label),
    h('select', { value: props.value, onChange: (e: { target: { value: string } }) => props.onChange(e.target.value) },
      props.options.map(o => h('option', { key: o, value: o }, o))),
  )
}

/** The configuration page body (`view: 'page'` — own save controls). */
function TerminalConfigPage(props: { form?: FormContract }): any {
  const form: FormContract = props.form ?? {}
  const [drafts, setDrafts] = React.useState(() => presetsOf(form))
  const [selected, setSelected] = React.useState(0)
  const [status, setStatus] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    // Re-sync staged edits when the host re-renders with a fresh view (the
    // page owns its draft; only a save writes — host contract).
    if (!saving && status === '') setDrafts(presetsOf(form))
  }, [form]) // re-sync on form identity only (the page owns its draft)

  const current = drafts[selected] ?? blankDraft()
  const patchCurrent = (patch: Partial<PresetDraft>) => {
    setDrafts((list: PresetDraft[]) => list.map((d, i) => (i === selected ? { ...d, ...patch } : d)))
  }

  const save = async () => {
    const ids = new Set<string>()
    for (const d of drafts) {
      if (ids.has(d.id)) {
        setStatus(`预设 id 重复：${d.id}`)
        return
      }
      ids.add(d.id)
      // The #105-matrix client mirror (story 9): an invalid draft fails the
      // save LOUDLY here — the transport would silently skip a hostile id.
      const problem = validateDraft(d)
      if (problem !== undefined) {
        setStatus(problem)
        return
      }
    }
    if (typeof form.mutate !== 'function') {
      setStatus('此行不接受写入（表单合同缺失）。')
      return
    }
    setSaving(true)
    try {
      const revision = snapshotOf(form)?.revision
      const accepted = await form.mutate([{ op: 'set', path: [CUSTOM_PATH], value: drafts }], revision)
      setStatus(accepted
        ? '已保存：写入了 terminal 行的 user 配置层，下次启动即生效（文件族随之物化）。'
        : '保存冲突：配置已被其他写入方修改。刷新页面后重试（staged 修改保留）。')
    } catch (error) {
      setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }

  return h('div', { style: { maxWidth: 640 } },
    h('h3', { style: { margin: '8px 0' } }, '自定义 shell 预设'),
    h('p', { style: { margin: '4px 0', opacity: 0.8 } },
      '自定义预设保存在 custom.d 文件族（每条一个 <id>.json）；此页面是它的 GUI —— 保存经 settings 写入并由宿主半幅物化成文件。内置预设只读，不在此列表。'),
    h('ul', { style: { paddingLeft: 16 } },
      drafts.map((d, i) => h('li', { key: `${d.id}-${i}`, style: { margin: '2px 0' } },
        h('button', {
          onClick: () => { setSelected(i); setStatus('') },
          style: { fontWeight: i === selected ? 700 : 400, marginRight: 8 },
        }, d.id || '(未命名)'),
        h('code', { style: { marginRight: 8 } }, previewOf(d)),
        h('button', {
          onClick: () => {
            setDrafts((list: PresetDraft[]) => list.filter((_, j) => j !== i))
            setSelected(0)
            setStatus('')
          },
        }, '删除')))),
    h('div', { style: { margin: '8px 0' } },
      h('button', {
        onClick: () => {
          setDrafts((list: PresetDraft[]) => [...list, blankDraft()])
          setSelected(drafts.length)
          setStatus('')
        },
      }, '新增预设')),
    h('div', { style: { borderTop: '1px solid var(--dsw-alias-color-border, #888)', paddingTop: 8 } },
      TextField({ label: 'id', value: current.id, onChange: v => patchCurrent({ id: v }), placeholder: '字母开头的 [A-Za-z0-9._-]' }),
      SelectField({ label: 'transport', value: current.transport, options: ['local', 'ssh'], onChange: v => patchCurrent({ transport: v as PresetDraft['transport'] }) }),
      current.transport === 'local'
        ? h(React.Fragment, null,
            TextField({ label: 'executable', value: (current.executable ?? []).join(', '), onChange: v => patchCurrent({ executable: v.split(',').map(s => s.trim()).filter(s => s !== '') }), placeholder: '候选绝对路径，逗号分隔' }),
            TextField({ label: 'argv', value: (current.argv ?? []).join(', '), onChange: v => patchCurrent({ argv: v.split(',').map(s => s.trim()) }), placeholder: '逗号分隔' }),
            TextField({ label: 'base', value: current.base ?? '', onChange: v => patchCurrent({ base: v === '' ? undefined : v }), placeholder: '继承的内置预设 id（可选）' }),
            TextField({ label: 'cwd', value: current.cwd ?? '', onChange: v => patchCurrent({ cwd: v === '' ? undefined : v }), placeholder: '绝对路径（可选）' }))
        : h(React.Fragment, null,
            TextField({ label: 'host', value: current.host ?? '', onChange: v => patchCurrent({ host: v }) }),
            TextField({ label: 'port', value: current.port === undefined ? '' : String(current.port), onChange: v => patchCurrent({ port: v === '' ? undefined : Number(v) }) }),
            TextField({ label: 'shell', value: current.shell ?? '', onChange: v => patchCurrent({ shell: v === '' ? undefined : v }), placeholder: '登录 shell（可选）' })),
      h('div', { style: { margin: '8px 0', opacity: 0.85 } },
        h('span', { style: { marginRight: 8 } }, '启动命令预览：'),
        h('code', null, previewOf(current))),
      h('div', { style: { margin: '8px 0' } },
        h('button', { onClick: () => void save(), disabled: saving }, saving ? '保存中…' : '保存'),
        status === '' ? null : h('span', { style: { marginLeft: 12 } }, status))),
  )
}

/** The bundle's client half: one factory, registered when materialized. */
export function apply(ctx: {
  slots?: {
    inject: (slot: string, factory: () => unknown) => void
    register: (spec: { name: string; key: string }, component: (props: unknown) => any) => void
  }
}): void {
  const slots = ctx.slots
  if (slots === undefined) return
  slots.inject('plugins.row.config', () =>
    slots.register({ name: 'plugins.row.config', key: ROW_KEY }, (props: { view?: string; form?: FormContract }) =>
      props.view === 'page' ? h(TerminalConfigPage, { form: props.form }) : null),
  )
}
