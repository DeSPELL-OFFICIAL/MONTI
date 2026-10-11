import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { organizerCopy } from '../copy';
import { platformRow, type RecipientRow } from './settlementModel';
import { SplitEditor } from './SplitEditor';

const copy = organizerCopy.ko.settlement;
const PLATFORM = `0x${'cc'.repeat(20)}`;
const BAND: RecipientRow = { id: 'b', name: '밴드', account: `0x${'a1'.repeat(20)}`, bps: 9_500, tag: 'band' };

describe('SplitEditor', () => {
  it('locks the MONTI platform row: its name is read-only and it cannot be removed', () => {
    render(<SplitEditor rows={[platformRow(PLATFORM)]} onChange={vi.fn()} exampleCents={3_000} />);
    expect(screen.getByDisplayValue('MONTI 플랫폼')).toHaveAttribute('readonly');
    expect(screen.getByText(copy.platformNote)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.removeRow })).toBeNull();
  });

  it('shows the live sum, the error until it is 100%, and the example on the draft price', () => {
    const { rerender } = render(<SplitEditor rows={[platformRow(PLATFORM)]} onChange={vi.fn()} exampleCents={2_000} />);
    expect(screen.getByText(`${copy.sumLabel}: 5%`)).toBeInTheDocument();
    expect(screen.getByText(copy.errors.badSum)).toBeInTheDocument();
    expect(screen.getByText('예시 · $20.00 티켓이면')).toBeInTheDocument();

    rerender(<SplitEditor rows={[BAND, platformRow(PLATFORM)]} onChange={vi.fn()} exampleCents={2_000} />);
    expect(screen.getByText(`${copy.sumLabel}: 100%`)).toBeInTheDocument();
    expect(screen.queryByText(copy.errors.badSum)).toBeNull();
    expect(screen.getByText('밴드 · $19.00')).toBeInTheDocument();
  });

  it('hands every edit back as whole rows: add, change a share, remove', () => {
    const onChange = vi.fn();
    render(<SplitEditor rows={[BAND, platformRow(PLATFORM)]} onChange={onChange} exampleCents={3_000} />);

    fireEvent.click(screen.getByRole('button', { name: copy.addRow }));
    expect(onChange.mock.calls.at(-1)?.[0]).toHaveLength(3);

    fireEvent.change(screen.getAllByLabelText(copy.percentLabel)[0] as HTMLElement, { target: { value: '90' } });
    expect(onChange.mock.calls.at(-1)?.[0][0]).toMatchObject({ id: 'b', bps: 9_000 });

    fireEvent.click(screen.getByRole('button', { name: copy.removeRow }));
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual([platformRow(PLATFORM)]);
  });
});
