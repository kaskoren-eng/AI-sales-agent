import { useState, type FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import * as Dialog from '@radix-ui/react-dialog'
import { UserPlus, X, Copy, Check, Trash2, ShieldAlert } from 'lucide-react'
import { Button } from '../components/ui/Button.js'
import { Input } from '../components/ui/Input.js'
import { Select } from '../components/ui/Select.js'
import { Badge } from '../components/ui/Badge.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { useToast } from '../components/ui/Toast.js'
import { getSession } from '../lib/auth.js'
import { formatDate } from '../lib/format.js'
import {
  fetchMembers,
  inviteMember,
  updateMemberRole,
  removeMember,
  INVITABLE_ROLES,
  type Member,
  type TenantRole,
} from '../lib/api.js'

/**
 * Team members.
 *
 * WHY THIS PAGE EXISTS: `src/modules/auth/members.routes.ts` has had a complete, role-guarded
 * members API since accounts shipped — list, invite, change role, remove — and NOTHING in the
 * dashboard called any of it. The login screen can *accept* an invite; there was no way anywhere
 * to *send* one. So whoever registered a workspace was permanently its only user, and a customer
 * could not add their own sales manager. Same shape of bug as the Integrations page, and a harder
 * blocker: it caps every customer at one seat.
 *
 * The server is the authority on permissions — every mutating route is behind `requireRole('admin')`
 * and the owner rules are enforced there. This page mirrors those rules in the UI so that people
 * are not offered buttons that will 403, but it never relies on the mirror being right.
 */

const ROLE_ORDER: Record<TenantRole, number> = { owner: 0, admin: 1, member: 2, viewer: 3 }

/** Owner and admin may manage the team; member and viewer may only look at it. */
function canManage(role: TenantRole | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

export function Members() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const session = getSession()
  const myRole = session?.tenant.role
  const myUserId = session?.user.id
  const manage = canManage(myRole)

  const [inviteOpen, setInviteOpen] = useState(false)

  const { data, isLoading, error } = useQuery({ queryKey: ['members'], queryFn: fetchMembers })

  const roleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: TenantRole }) => updateMemberRole(userId, role),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['members'] })
      toast({ variant: 'success', title: t('members.roleChanged') })
    },
    onError: (err: Error) => toast({ variant: 'error', title: t('members.roleFailed'), description: err.message }),
  })

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeMember(userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['members'] })
      toast({ variant: 'success', title: t('members.removed') })
    },
    onError: (err: Error) => toast({ variant: 'error', title: t('members.removeFailed'), description: err.message }),
  })

  const members = [...(data?.members ?? [])].sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.email.localeCompare(b.email),
  )

  return (
    <div style={{ maxInlineSize: '900px', marginInline: 'auto', paddingBlockEnd: '48px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px', marginBlockEnd: '20px' }}>
        <p style={{ fontSize: '13.5px', color: 'var(--text-secondary)', margin: 0, flex: 1 }}>
          {t('members.sub')}
        </p>
        {manage && (
          <Button variant="primary" onClick={() => setInviteOpen(true)}>
            <UserPlus size={15} strokeWidth={1.9} />
            {t('members.invite')}
          </Button>
        )}
      </div>

      {/* A viewer or member sees the team but no controls. Saying so beats silently hiding them. */}
      {!manage && !isLoading && (
        <div
          style={{
            display: 'flex',
            gap: '10px',
            alignItems: 'center',
            padding: '12px 14px',
            borderRadius: 'var(--r)',
            background: 'var(--surface-sunken)',
            border: '1px solid var(--border-default)',
            marginBlockEnd: '16px',
            fontSize: '12.5px',
            color: 'var(--text-secondary)',
          }}
        >
          <ShieldAlert size={16} strokeWidth={1.8} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
          <span>{t('members.readOnly')}</span>
        </div>
      )}

      <div
        style={{
          background: 'var(--surface-card)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--r)',
          boxShadow: 'var(--shadow-card)',
          overflow: 'hidden',
        }}
      >
        {isLoading && (
          <div style={{ padding: '16px', display: 'grid', gap: '10px' }}>
            <Skeleton height="44px" />
            <Skeleton height="44px" />
          </div>
        )}

        {error && (
          <p style={{ padding: '20px', margin: 0, fontSize: '13px', color: 'var(--status-danger)' }}>
            {(error as Error).message}
          </p>
        )}

        {!isLoading &&
          !error &&
          members.map((m, i) => (
            <MemberRow
              key={m.userId}
              member={m}
              first={i === 0}
              isSelf={m.userId === myUserId}
              myRole={myRole}
              busy={roleMutation.isPending || removeMutation.isPending}
              onRole={(role) => roleMutation.mutate({ userId: m.userId, role })}
              onRemove={() => removeMutation.mutate(m.userId)}
            />
          ))}
      </div>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  )
}

function MemberRow({
  member,
  first,
  isSelf,
  myRole,
  busy,
  onRole,
  onRemove,
}: {
  member: Member
  first: boolean
  isSelf: boolean
  myRole: TenantRole | undefined
  busy: boolean
  onRole: (role: TenantRole) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()

  // Mirrors the two server rules that are easy to trip over:
  //  - only an owner may grant ownership (otherwise an admin promotes themselves, then removes the
  //    owner — a one-step takeover, which is why the server refuses it);
  //  - you cannot remove yourself, because that is how people lock themselves out of a workspace.
  const manage = canManage(myRole)
  const roleOptions: TenantRole[] = myRole === 'owner' ? ['owner', 'admin', 'member', 'viewer'] : [...INVITABLE_ROLES]
  // An admin cannot demote an owner either — the server would 403, so don't offer it.
  const editable = manage && !(member.role === 'owner' && myRole !== 'owner')

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        padding: '14px 18px',
        borderBlockStart: first ? 'none' : '1px solid var(--border-default)',
      }}
    >
      <div style={{ flex: 1, minInlineSize: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              fontSize: '14px',
              fontWeight: 600,
              color: 'var(--text-primary)',
              // Invited-but-never-signed-in people have no name yet, so the email IS the identity.
              // Setting it in mono here keeps it from being repeated on the line below.
              ...(member.name ? {} : { fontFamily: 'var(--font-mono)', fontSize: '13px' }),
            }}
            dir="auto"
          >
            {member.name || member.email}
          </span>
          {isSelf && <Badge variant="info">{t('members.you')}</Badge>}
        </div>
        {member.name && (
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              color: 'var(--text-tertiary)',
              marginBlockStart: '2px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {member.email}
          </div>
        )}
        <div style={{ fontSize: '11.5px', color: 'var(--text-tertiary)', marginBlockStart: '3px' }}>
          {member.lastLoginAt
            ? t('members.lastSeen', { when: formatDate(member.lastLoginAt) })
            : t('members.neverSignedIn')}
        </div>
      </div>

      {editable ? (
        <Select
          value={member.role}
          disabled={busy}
          fullWidth={false}
          aria-label={t('members.role')}
          onChange={(e) => onRole(e.target.value as TenantRole)}
          options={roleOptions.map((r) => ({ value: r, label: t(`members.roles.${r}`) }))}
        />
      ) : (
        <Badge variant={member.role === 'owner' ? 'violet' : 'default'}>{t(`members.roles.${member.role}`)}</Badge>
      )}

      {manage && !isSelf && member.role !== 'owner' ? (
        <Button variant="ghost" size="sm" disabled={busy} onClick={onRemove} aria-label={t('members.remove')}>
          <Trash2 size={15} strokeWidth={1.8} />
        </Button>
      ) : (
        // Keeps the role controls from shifting between rows that can and cannot be removed.
        <span style={{ inlineSize: '38px', flexShrink: 0 }} aria-hidden="true" />
      )}
    </div>
  )
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<TenantRole>('member')
  /** Set only when the server could not mail the link and handed us the raw token instead. */
  const [manualToken, setManualToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const mutation = useMutation({
    mutationFn: () => inviteMember({ email: email.trim(), role }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['members'] })
      if (result.sent) {
        toast({ variant: 'success', title: t('members.inviteSent'), description: email.trim() })
        close()
        return
      }
      // NOT a success toast. The server has no DASHBOARD_BASE_URL, so no email went anywhere —
      // exactly the failure that made password resets vanish silently. Show the link instead of
      // claiming it was sent, so the invite can still be completed by hand.
      setManualToken(result.token)
    },
    onError: (err: Error) => toast({ variant: 'error', title: t('members.inviteFailed'), description: err.message }),
  })

  function close() {
    onOpenChange(false)
    setEmail('')
    setRole('member')
    setManualToken(null)
    setCopied(false)
  }

  const link = manualToken
    ? `${window.location.origin}/accept-invite?token=${encodeURIComponent(manualToken)}`
    : ''

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!email.trim() || mutation.isPending) return
    mutation.mutate()
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <Dialog.Portal>
        <Dialog.Overlay
          style={{ position: 'fixed', inset: 0, background: 'rgba(12,18,38,.45)', backdropFilter: 'blur(2px)' }}
        />
        <Dialog.Content
          style={{
            position: 'fixed',
            insetBlockStart: '50%',
            insetInlineStart: '50%',
            transform: 'translate(-50%, -50%)',
            inlineSize: 'min(460px, calc(100vw - 32px))',
            background: 'var(--surface-card)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--r)',
            boxShadow: 'var(--shadow-modal, var(--shadow-card))',
            padding: '22px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', marginBlockEnd: '16px' }}>
            <Dialog.Title
              style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '17px', margin: 0, flex: 1 }}
            >
              {manualToken ? t('members.inviteManualTitle') : t('members.inviteTitle')}
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label={t('members.close')}>
                <X size={16} strokeWidth={1.9} />
              </Button>
            </Dialog.Close>
          </div>

          {manualToken ? (
            <>
              <Dialog.Description style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '0 0 14px' }}>
                {t('members.inviteManualNote')}
              </Dialog.Description>
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11.5px',
                  wordBreak: 'break-all',
                  background: 'var(--surface-sunken)',
                  border: '1px solid var(--border-default)',
                  borderRadius: '8px',
                  padding: '10px 12px',
                  color: 'var(--text-primary)',
                }}
                dir="ltr"
              >
                {link}
              </div>
              <div style={{ display: 'flex', gap: '10px', marginBlockStart: '16px', justifyContent: 'flex-end' }}>
                <Button
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard.writeText(link).then(() => setCopied(true))
                  }}
                >
                  {copied ? <Check size={15} strokeWidth={2} /> : <Copy size={15} strokeWidth={1.8} />}
                  {copied ? t('members.copied') : t('members.copyLink')}
                </Button>
                <Button variant="primary" onClick={close}>
                  {t('members.done')}
                </Button>
              </div>
            </>
          ) : (
            <form onSubmit={submit}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '7px', marginBlockEnd: '14px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                  {t('members.email')}
                </span>
                <Input
                  type="email"
                  autoFocus
                  required
                  dir="ltr"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                  {t('members.role')}
                </span>
                <Select
                  value={role}
                  onChange={(e) => setRole(e.target.value as TenantRole)}
                  options={INVITABLE_ROLES.map((r) => ({ value: r, label: t(`members.roles.${r}`) }))}
                />
                <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
                  {t(`members.roleHints.${role}`)}
                </span>
              </label>

              <div style={{ display: 'flex', gap: '10px', marginBlockStart: '20px', justifyContent: 'flex-end' }}>
                <Button type="button" variant="secondary" onClick={close}>
                  {t('members.cancel')}
                </Button>
                <Button type="submit" variant="primary" loading={mutation.isPending} disabled={!email.trim()}>
                  {t('members.sendInvite')}
                </Button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
