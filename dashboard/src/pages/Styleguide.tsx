import { useState, type ReactNode } from 'react'
import { Search, Users } from 'lucide-react'
import { Button } from '../components/ui/Button.js'
import { Badge } from '../components/ui/Badge.js'
import { Card } from '../components/ui/Card.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { Input } from '../components/ui/Input.js'
import { Select } from '../components/ui/Select.js'
import { TextArea } from '../components/ui/TextArea.js'
import { EmptyState } from '../components/ui/EmptyState.js'
import { PageHeader } from '../components/ui/PageHeader.js'
import { Bidi } from '../components/ui/Bidi.js'
import { Modal } from '../components/ui/Modal.js'
import { Tabs } from '../components/ui/Tabs.js'
import { useToast } from '../components/ui/Toast.js'
import { LanguageSwitcher } from '../components/LanguageSwitcher.js'

// Dev-only visual inventory. Not a showcase — the regression net for every primitive, in
// both reading directions. Copy is intentionally plain and untranslated; this page exists to
// eyeball layout, not language. Portaled components (Modal, Toast) follow the global language
// toggle, since they render at the document root rather than inside the forced-dir panels.

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: '28px' }}>
      <p
        style={{
          fontSize: '11px',
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--text-muted)',
          marginBottom: '12px',
        }}
      >
        {title}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'flex-start' }}>
        {children}
      </div>
    </div>
  )
}

function Inventory() {
  const { toast } = useToast()
  const [modalOpen, setModalOpen] = useState(false)
  const [selectValue, setSelectValue] = useState('')

  const statusOptions = [
    { value: 'new', label: 'New' },
    { value: 'qualified', label: 'Qualified' },
    { value: 'booked', label: 'Booked' },
  ]

  return (
    <Card>
      <Section title="Buttons">
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
        <Button variant="primary" loading>
          Loading
        </Button>
        <Button variant="primary" disabled>
          Disabled
        </Button>
        <Button variant="secondary" size="sm">
          Small
        </Button>
        <Button variant="secondary" size="lg">
          Large
        </Button>
      </Section>

      <Section title="Badges">
        <Badge variant="success">success</Badge>
        <Badge variant="warning">warning</Badge>
        <Badge variant="error">error</Badge>
        <Badge variant="info">info</Badge>
        <Badge variant="violet">violet</Badge>
        <Badge variant="default">default</Badge>
      </Section>

      <Section title="Input">
        <div style={{ width: '240px' }}>
          <Input placeholder="Default" />
        </div>
        <div style={{ width: '240px' }}>
          <Input placeholder="Search…" startIcon={<Search size={15} strokeWidth={1.5} />} />
        </div>
        <div style={{ width: '240px' }}>
          <Input placeholder="Invalid" invalid />
        </div>
        <div style={{ width: '240px' }}>
          <Input placeholder="Disabled" disabled />
        </div>
        <div style={{ width: '160px' }}>
          <Input placeholder="Small" size="sm" />
        </div>
      </Section>

      <Section title="Select">
        <div style={{ width: '200px' }}>
          <Select
            options={statusOptions}
            placeholder="All statuses"
            value={selectValue}
            onChange={(e) => setSelectValue(e.target.value)}
          />
        </div>
        <div style={{ width: '200px' }}>
          <Select options={statusOptions} placeholder="Invalid" invalid />
        </div>
        <div style={{ width: '160px' }}>
          <Select options={statusOptions} placeholder="Small" size="sm" />
        </div>
      </Section>

      <Section title="TextArea">
        <div style={{ width: '280px' }}>
          <TextArea placeholder="Default (2 rows)" rows={2} />
        </div>
        <div style={{ width: '280px' }}>
          <TextArea userContent defaultValue="שלום, זו הערה בעברית — dir=auto" rows={2} />
        </div>
        <div style={{ width: '280px' }}>
          <TextArea placeholder="Invalid" invalid rows={2} />
        </div>
      </Section>

      <Section title="Bidi (user content)">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <Bidi style={{ fontSize: '13px', color: 'var(--text-primary)' }}>דניאל מזרחי</Bidi>
          <Bidi style={{ fontSize: '13px', color: 'var(--text-primary)' }}>Daniel Mizrahi</Bidi>
        </div>
      </Section>

      <Section title="PageHeader">
        <div style={{ width: '100%' }}>
          <PageHeader
            title="Page Header"
            subtitle="Uppercase in Latin, Heebo + normal case in Hebrew"
            actions={<Button variant="primary" size="sm">Action</Button>}
          />
        </div>
      </Section>

      <Section title="Tabs">
        <div style={{ width: '100%' }}>
          <Tabs
            ariaLabel="Styleguide tabs"
            items={[
              { value: 'a', label: 'First', content: <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>First panel</span> },
              { value: 'b', label: 'Second', content: <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Second panel</span> },
              { value: 'c', label: 'Third', content: <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Third panel</span> },
            ]}
          />
        </div>
      </Section>

      <Section title="Modal & Toast (portaled — follow global language)">
        <Button variant="secondary" size="sm" onClick={() => setModalOpen(true)}>
          Open modal
        </Button>
        <Button variant="secondary" size="sm" onClick={() => toast({ variant: 'success', title: 'Saved', description: 'Changes stored.' })}>
          Toast: success
        </Button>
        <Button variant="secondary" size="sm" onClick={() => toast({ variant: 'error', title: 'Failed', description: 'Try again.' })}>
          Toast: error
        </Button>
        <Button variant="secondary" size="sm" onClick={() => toast({ variant: 'info', title: 'Heads up' })}>
          Toast: info
        </Button>
        <Modal
          open={modalOpen}
          onOpenChange={setModalOpen}
          title="Modal title"
          description="Modal description — focus-trapped, Esc closes."
          footer={
            <>
              <Button variant="secondary" size="sm" onClick={() => setModalOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={() => setModalOpen(false)}>
                Confirm
              </Button>
            </>
          }
        />
      </Section>

      <Section title="EmptyState">
        <div style={{ width: '100%' }}>
          <EmptyState
            icon={<Users size={32} strokeWidth={1} />}
            title="No leads yet"
            description="Connect a channel to start receiving leads."
          />
        </div>
      </Section>

      <Section title="Skeleton (loading)">
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <Skeleton height="14px" width="40%" />
          <Skeleton height="14px" width="70%" />
          <Skeleton height="14px" width="55%" />
        </div>
      </Section>
    </Card>
  )
}

export function Styleguide() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' }}>
        <div>
          <h1 style={{ fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: '20px', color: 'var(--text-primary)', margin: 0 }}>
            Primitives Styleguide
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Dev-only inventory · every primitive, both directions. Toggle language to see strings + portaled components flip.
          </p>
        </div>
        <LanguageSwitcher />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', alignItems: 'start' }}>
        <div dir="ltr">
          <p style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '10px' }}>LTR</p>
          <Inventory />
        </div>
        <div dir="rtl">
          <p style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '10px' }}>RTL</p>
          <Inventory />
        </div>
      </div>
    </div>
  )
}
