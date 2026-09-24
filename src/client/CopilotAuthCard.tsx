/**
 * CopilotAuthCard — the `plugins.row.config` slot occupant (key
 * `@huanlin/dsh-plugin-copilot#dsh-plugin-copilot`).
 *
 * The plugin's configuration page on the Plugins page, rendering the
 * onboarding state machine:
 * unsupported (no pi-ai flow) / logged-out / pending (device code + polling
 * + cancel + prompts) / success / error, plus logged-in actions (sign out,
 * activate-route autofill when the profile is missing).
 *
 * @module @huanlin/dsh-plugin-copilot/client/CopilotAuthCard
 */
import { useState, type CSSProperties } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { CopilotCardState } from './controller.ts'
import type { CopilotAuthController } from './controller.ts'

/** Inject face: the shared controller. */
export interface CopilotCardInjected {
  readonly controller: CopilotAuthController
  readonly useCard: <S>(select: (state: CopilotCardState) => S) => S
}

/** Full props: the `plugins.row.config` owner share (view + form), locale seat, and inject. */
export type CopilotCardProps =
  PropsRuntime<'plugins.row.config'>
  & PropsLocale<'dsh-plugin-copilot'>
  & CopilotCardInjected

const cardStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22))',
  background: 'var(--dsw-alias-bg-layer-3, transparent)',
  borderRadius: 12,
  listStyle: 'none',
}

const headerStyle: CSSProperties = {
  width: '100%',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  background: 'transparent',
  border: 0,
  borderRadius: 12,
  alignItems: 'center',
  gap: 12,
  padding: '14px 16px',
  display: 'flex',
  boxSizing: 'border-box',
}

const headTextStyle: CSSProperties = {
  flexDirection: 'column',
  flex: 1,
  gap: 4,
  minWidth: 0,
  display: 'flex',
}

const titleStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-primary, inherit)',
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1.4,
}

const descStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.7))',
  fontSize: 13,
  lineHeight: 1.5,
}

const badgeStyle = (tone: 'ok' | 'warn'): CSSProperties => ({
  whiteSpace: 'nowrap',
  background: tone === 'ok'
    ? 'var(--dsw-alias-state-success-bg, rgba(48,209,88,0.14))'
    : 'var(--dsw-alias-bg-module-platform, rgba(128,128,128,0.12))',
  color: tone === 'ok'
    ? 'var(--dsw-alias-state-success-primary, #30d158)'
    : 'var(--dsw-alias-label-secondary, inherit)',
  borderRadius: 999,
  flex: 'none',
  padding: '1px 8px',
  fontSize: 11,
  fontWeight: 500,
  lineHeight: '17px',
})

const bodyStyle: CSSProperties = {
  borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.22))',
  margin: '0 16px',
  padding: '12px 0 4px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
}

const noticeStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary, inherit)',
  margin: 0,
  fontSize: 12,
  lineHeight: 1.6,
}

const errorStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-error, #ff453a)',
  margin: 0,
  fontSize: 12,
  lineHeight: 1.6,
}

const successStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-success-primary, #30d158)',
  margin: 0,
  fontSize: 12,
  lineHeight: 1.6,
}

const codeRowStyle: CSSProperties = {
  alignItems: 'center',
  gap: 10,
  display: 'flex',
  flexWrap: 'wrap',
}

const codeStyle: CSSProperties = {
  fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
  fontSize: 20,
  fontWeight: 700,
  letterSpacing: 2,
  color: 'var(--dsw-alias-label-primary, inherit)',
}

const btnBase: CSSProperties = {
  appearance: 'none',
  font: 'inherit',
  cursor: 'pointer',
  border: '1px solid transparent',
  borderRadius: 8,
  padding: '5px 14px',
  fontSize: 13,
  fontWeight: 500,
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-primary, inherit)',
  background: 'var(--dsw-alias-bg-module-platform, rgba(128,128,128,0.12))',
}

const btnPrimary: CSSProperties = {
  ...btnBase,
  background: 'var(--dsw-alias-brand-primary, #0a84ff)',
  color: 'var(--dsw-alias-bg-layer-1, #fff)',
}

const actionsStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
  paddingBottom: 10,
}

const inputStyle: CSSProperties = {
  flex: 1,
  padding: '6px 10px',
  fontSize: 13,
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
  background: 'var(--dsw-alias-bg-layer-3, transparent)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
  minWidth: 0,
}

const modelsStyle: CSSProperties = {
  fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary, inherit)',
  overflowWrap: 'anywhere',
}

const CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>'

/**
 * Render the Copilot onboarding card.
 * @param props - locale + controller inject.
 * @returns a `<li>` card element.
 */
export function CopilotAuthCard({ view, t, controller, useCard }: CopilotCardProps) {
  const state = useCard(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [promptAnswer, setPromptAnswer] = useState('')
  if (!state.loaded) void controller.load()

  // The row detail page uses `summary` only when the package description is
  // absent; render a one-liner there and the onboarding card otherwise.
  if (view === 'summary') return t('card.intro')

  const unsupported = state.loaded && !state.status.flowAvailable
  // A login lifecycle in flight or freshly settled keeps the card open: the
  // device code and its outcome must never hide behind a collapsed header.
  const loginRevealed = state.login.kind !== 'idle'
  const expanded = open || unsupported || loginRevealed
  const busy = state.busy

  const header = (
    <button
      type="button"
      style={headerStyle}
      aria-expanded={expanded}
      aria-label={t('card.title')}
      onClick={() => { setOpen(!open) }}
    >
      <span style={headTextStyle}>
        <span style={titleStyle}>{t('card.title')}</span>
        <span style={descStyle}>{t('card.intro')}</span>
      </span>
      {state.status.loggedIn
        ? <span style={badgeStyle('ok')}>{t('card.signedIn')}</span>
        : state.loaded && state.status.flowAvailable
          ? <span style={badgeStyle('warn')}>{t('card.signedOut')}</span>
          : null}
      {state.status.loggedIn
        ? <span style={badgeStyle(state.status.profileActivated ? 'ok' : 'warn')}>
            {t(state.status.profileActivated ? 'card.routeActive' : 'card.routeDormant')}
          </span>
        : null}
      <span
        style={{ color: 'var(--dsw-alias-label-tertiary, inherit)', flex: 'none', display: 'inline-flex', transform: expanded ? 'rotate(180deg)' : 'none' }}
        dangerouslySetInnerHTML={{ __html: CHEVRON_SVG }}
      />
    </button>
  )

  if (!expanded) {
    return <li style={cardStyle}>{header}</li>
  }

  return (
    <li style={cardStyle}>
      {header}
      <div style={bodyStyle}>
        {unsupported ? <p style={noticeStyle} role="status">{t('card.unsupported')}</p> : null}

        {!unsupported && state.login.kind === 'idle' ? (
          <>
            {state.status.loggedIn ? null : (
              <div style={actionsStyle}>
                <button
                  type="button"
                  style={btnPrimary}
                  disabled={busy}
                  onClick={() => { void controller.login() }}
                >
                  {t('action.signIn')}
                </button>
              </div>
            )}
            {state.status.loggedIn ? (
              <div style={actionsStyle}>
                {!state.status.profileActivated ? (
                  <button
                    type="button"
                    style={btnPrimary}
                    disabled={busy}
                    onClick={() => { void controller.autofill() }}
                  >
                    {t('action.activate')}
                  </button>
                ) : null}
                <button
                  type="button"
                  style={btnBase}
                  disabled={busy}
                  onClick={() => { void controller.autofill() }}
                >
                  {t('action.syncModels')}
                </button>
                <button
                  type="button"
                  style={btnBase}
                  disabled={busy}
                  onClick={() => { void controller.logout() }}
                >
                  {t('action.signOut')}
                </button>
              </div>
            ) : null}
          </>
        ) : null}

        {state.login.kind === 'running' ? (
          <>
            <p style={noticeStyle} role="status">{t('state.pending')}</p>
            {state.deviceCode !== undefined ? (
              <div style={codeRowStyle}>
                <span style={noticeStyle}>{t('notice.deviceCode')}</span>
                <span style={codeStyle}>{state.deviceCode}</span>
                <button
                  type="button"
                  style={btnBase}
                  onClick={() => {
                    void navigator.clipboard?.writeText(state.deviceCode ?? '')
                    controller.markCopied()
                  }}
                >
                  {t(state.copied ? 'action.copied' : 'action.copyCode')}
                </button>
                {state.verificationUrl !== undefined ? (
                  // window.open with a features string instead of an anchor:
                  // in-page link clicks are intercepted by sidebar extensions
                  // (dsh-better-sidebar renders them inside the app shell), while
                  // a programmatic open with size features always lands in a
                  // real browser window outside the app.
                  <button
                    type="button"
                    style={btnBase}
                    onClick={() => {
                      window.open(state.verificationUrl, '_blank', 'noopener,noreferrer,width=960,height=760')
                    }}
                  >
                    {t('action.openUrl')}
                  </button>
                ) : null}
              </div>
            ) : null}
            {state.events.filter(event => event.kind === 'notice' && event.code === undefined && event.message)
              .slice(-2)
              .map(event => <p key={event.seq} style={noticeStyle}>{event.message}</p>)}
            <div style={actionsStyle}>
              <button type="button" style={btnBase} disabled={busy} onClick={() => { void controller.cancel() }}>
                {t('action.cancel')}
              </button>
            </div>
          </>
        ) : null}

        {state.openPrompt !== undefined && state.openPrompt.prompt !== undefined ? (
          <>
            <p style={noticeStyle} role="status">{t('state.pendingPrompt')}</p>
            <p style={noticeStyle}>{state.openPrompt.prompt.message}</p>
            <div style={codeRowStyle}>
              {state.openPrompt.prompt.options === undefined ? (
                <>
                  <input
                    type={state.openPrompt.prompt.kind === 'secret' ? 'password' : 'text'}
                    style={inputStyle}
                    value={promptAnswer}
                    placeholder={state.openPrompt.prompt.placeholder ?? t('prompt.placeholder')}
                    onChange={(event) => { setPromptAnswer(event.target.value) }}
                  />
                  <button
                    type="button"
                    style={btnPrimary}
                    disabled={busy}
                    onClick={() => {
                      void controller.answer(promptAnswer, false)
                      setPromptAnswer('')
                    }}
                  >
                    {t('action.submit')}
                  </button>
                </>
              ) : state.openPrompt.prompt.options.map(option => (
                <button
                  key={option.id}
                  type="button"
                  style={btnBase}
                  onClick={() => { void controller.answer(option.id, false) }}
                >
                  {option.label}
                </button>
              ))}
              <button type="button" style={btnBase} onClick={() => { void controller.answer('', true) }}>
                {t('action.decline')}
              </button>
            </div>
          </>
        ) : null}

        {state.login.kind === 'success' ? (
          <p style={successStyle} role="status">{t('state.success')}</p>
        ) : null}

        {(state.login.kind === 'idle' || state.login.kind === 'success') && state.status.models !== undefined ? (
          <p style={noticeStyle}>
            {t('card.models')}
            {' '}
            <span style={modelsStyle}>
              {state.status.models.length > 0 ? state.status.models.join(', ') : '—'}
            </span>
          </p>
        ) : null}

        {state.login.kind === 'cancelled' ? (
          <p style={noticeStyle} role="status">
            {t('state.error')}
            {' '}
            <button type="button" style={btnBase} disabled={busy} onClick={() => { void controller.login() }}>
              {t('action.retry')}
            </button>
          </p>
        ) : null}

        {state.login.kind === 'error' ? (
          <p style={errorStyle} role="status">
            {t('state.error')}: {state.login.message}
            {' '}
            <button type="button" style={btnBase} disabled={busy} onClick={() => { void controller.login() }}>
              {t('action.retry')}
            </button>
          </p>
        ) : null}
      </div>
    </li>
  )
}
