import { useCallback, useState } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { Button, Screen } from '../shared/ui';
import { fmt } from '../shared/i18n';
import { useOrganizerCopy } from './copy';
import { useWizard } from './wizard/useWizard';
import { Step1Basic } from './wizard/Step1Basic';
import { Step2When } from './wizard/Step2When';
import { Step3Tiers } from './wizard/Step3Tiers';
import { Step4Rules } from './wizard/Step4Rules';
import { Step5Staff } from './wizard/Step5Staff';
import { Step6Review } from './wizard/Step6Review';

const LAST_STEP = 6;

/**
 * The six steps, over one draft. The draft is kept on this device (`useWizard`), so a reload
 * — or an organiser who closed the tab to go and find the venue address — comes back to what
 * they had typed. Only the last step sends anything anywhere.
 */
function Wizard() {
  const copy = useOrganizerCopy().wizard;
  const navigate = useNavigate();
  const { draft, patch, reset } = useWizard();
  const [step, setStep] = useState(1);

  const onNext = useCallback(() => setStep((current) => Math.min(LAST_STEP, current + 1)), []);
  const onBack = useCallback(() => setStep((current) => Math.max(1, current - 1)), []);
  const steps = { draft, patch, onNext, onBack };

  return (
    <Screen title={copy.heading}>
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>{fmt(copy.stepOf, { step })}</p>
      {step === 1 ? <Step1Basic draft={draft} patch={patch} onNext={onNext} /> : null}
      {step === 2 ? <Step2When {...steps} /> : null}
      {step === 3 ? <Step3Tiers {...steps} /> : null}
      {step === 4 ? <Step4Rules {...steps} /> : null}
      {step === 5 ? <Step5Staff {...steps} /> : null}
      {step === 6 ? (
        <Step6Review
          draft={draft}
          onBack={onBack}
          onPublished={reset}
          onDone={() => navigate('/org')}
        />
      ) : null}
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>{copy.saveDraft}</p>
      <Button
        variant="ghost"
        onClick={() => {
          reset();
          setStep(1);
        }}
      >
        {copy.startOver}
      </Button>
    </Screen>
  );
}

function OrganizerHome() {
  const copy = useOrganizerCopy().wizard;
  const navigate = useNavigate();
  return (
    <Screen title={copy.heading}>
      <Button onClick={() => navigate('/org/new')}>{copy.heading}</Button>
    </Screen>
  );
}

export function OrganizerRoutes() {
  return (
    <Routes>
      <Route index element={<OrganizerHome />} />
      <Route path="new" element={<Wizard />} />
    </Routes>
  );
}
